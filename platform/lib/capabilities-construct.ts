import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { Construct } from 'constructs';
import * as path from 'path';
import { loadMcpManifests, McpCapabilityManifest } from './manifest';
import { MCP_SERVER_NAME, MAX_COMBINED_TOOL_NAME } from './constants';

export interface CapabilitiesProps {
  /** Absolute path to the capabilities/ directory. */
  capabilitiesRoot: string;
  /** The Gateway to attach targets to. */
  gateway: agentcore.CfnGateway;
}

/**
 * Manifest-driven capability catalog.
 *
 * Scans capabilities/mcp/ and synthesizes one Gateway target per enabled manifest:
 *  - type: lambda        -> Lambda function + inline tool schema + least-privilege role
 *  - type: external-repo -> McpServer target with endpoint resolved from SSM
 *  - type: mcp-passthrough -> McpServer target with a literal endpoint URL
 *  - type: awslabs-reuse -> (M2) Lambda-packaged upstream server
 *
 * Governance is enforced at synth time by the manifest loader (readOnly contract,
 * no mutating IAM actions).
 */
export class Capabilities extends Construct {
  public readonly targets: agentcore.CfnGatewayTarget[] = [];
  public readonly manifests: McpCapabilityManifest[];
  /**
   * Fully-qualified Gateway tool names (`<targetName>___<toolName>`) for every enabled
   * lambda-backed tool. Used to derive the DevOps Agent Association allowlist so the
   * catalog and the allowlist can never drift.
   */
  public readonly toolNames: string[] = [];
  /** Scratch bucket for tool artifacts (reports etc.). Tools may write here and only here. */
  private readonly artifactBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: CapabilitiesProps) {
    super(scope, id);

    this.artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(30) }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    this.manifests = loadMcpManifests(props.capabilitiesRoot);

    for (const m of this.manifests) {
      if (!m.enabled) continue;

      switch (m.type) {
        case 'lambda':
          this.addLambdaTarget(m, props.gateway);
          break;
        case 'external-repo':
        case 'mcp-passthrough':
          this.addMcpServerTarget(m, props.gateway);
          break;
        case 'awslabs-reuse':
          // M2: package upstream awslabs server as a Lambda target.
          cdk.Annotations.of(this).addWarning(
            `${m.name}: awslabs-reuse packaging lands in M2 — skipped for now`
          );
          break;
      }
    }
  }

  private addLambdaTarget(m: McpCapabilityManifest, gateway: agentcore.CfnGateway): void {
    // Synth-time guard: DevOps Agent rejects tools where the combined registered
    // server name + '_' + Gateway tool name exceeds 64 chars. Fail fast here
    // rather than mid-deploy.
    for (const t of m.tools ?? []) {
      const combined = `${MCP_SERVER_NAME}_${m.name}___${t.name}`;
      if (combined.length > MAX_COMBINED_TOOL_NAME) {
        throw new Error(
          `${m.name}/${t.name}: combined MCP name '${combined}' is ${combined.length} chars ` +
            `(max ${MAX_COMBINED_TOOL_NAME}). Shorten the capability or tool name.`
        );
      }
      this.toolNames.push(`${m.name}___${t.name}`);
    }

    const fn = new lambda.Function(this, `${m.name}-fn`, {
      functionName: `gov-blueprint-${m.name}`,
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: (m.handler ?? 'lambda/handler.py').replace(/\.py$/, '').replace(/\//g, '.') + '.handler',
      code: lambda.Code.fromAsset(m.dir, { exclude: ['manifest.yaml', 'README.md'] }),
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      description: m.description,
      environment: { ARTIFACT_BUCKET: this.artifactBucket.bucketName },
    });

    // Exception to the read-only contract: tools may write artifacts to the
    // platform's own scratch bucket (presigned-URL delivery). Environment
    // resources remain read-only per the manifest validator.
    this.artifactBucket.grantReadWrite(fn);

    if (m.permissions?.length) {
      fn.addToRolePolicy(
        new iam.PolicyStatement({ actions: m.permissions, resources: ['*'] })
      );
    }

    const target = new agentcore.CfnGatewayTarget(this, `${m.name}-target`, {
      gatewayIdentifier: gateway.attrGatewayIdentifier,
      name: m.name,
      description: `${m.description}${m.retirement ? ` | Retirement: ${m.retirement.trim()}` : ''}`,
      targetConfiguration: {
        mcp: {
          lambda: {
            lambdaArn: fn.functionArn,
            toolSchema: {
              inlinePayload: (m.tools ?? []).map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema as any,
                ...(t.outputSchema ? { outputSchema: t.outputSchema as any } : {}),
              })),
            },
          },
        },
      },
      credentialProviderConfigurations: [
        { credentialProviderType: 'GATEWAY_IAM_ROLE' },
      ],
    });

    fn.addPermission(`${m.name}-gateway-invoke`, {
      principal: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceArn: gateway.attrGatewayArn,
    });

    this.targets.push(target);
  }

  private addMcpServerTarget(m: McpCapabilityManifest, gateway: agentcore.CfnGateway): void {
    let endpoint: string | undefined = m.endpoint?.url;
    if (!endpoint && m.endpoint?.ssmParameter) {
      endpoint = ssm.StringParameter.valueForStringParameter(this, m.endpoint.ssmParameter);
    }
    if (!endpoint) {
      cdk.Annotations.of(this).addWarning(`${m.name}: no endpoint configured — skipped`);
      return;
    }

    const target = new agentcore.CfnGatewayTarget(this, `${m.name}-target`, {
      gatewayIdentifier: gateway.attrGatewayIdentifier,
      name: m.name,
      description: `${m.description}${m.source ? ` | Source: ${m.source}` : ''}${m.retirement ? ` | Retirement: ${m.retirement.trim()}` : ''}`,
      targetConfiguration: {
        mcp: {
          mcpServer: { endpoint },
        },
      },
      credentialProviderConfigurations: [
        { credentialProviderType: 'GATEWAY_IAM_ROLE' },
      ],
    });

    this.targets.push(target);
  }
}
