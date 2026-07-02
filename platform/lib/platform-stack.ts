import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { Construct } from 'constructs';
import * as path from 'path';
import { Capabilities } from './capabilities-construct';

/**
 * The platform core: one AgentCore Gateway (the stable contract) plus the
 * manifest-driven capability catalog behind it.
 */
export class PlatformStack extends cdk.Stack {
  public readonly gatewayUrl: string;
  public readonly gatewayInvokeRoleArn: string;
  /** Fully-qualified Gateway tool names for the DevOps Agent allowlist. */
  public readonly toolNames: string[];

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Role the Gateway assumes to invoke targets (Lambdas, downstream MCP servers)
    const gatewayRole = new iam.Role(this, 'GatewayRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'Assumed by AgentCore Gateway to invoke capability targets',
    });
    gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [`arn:aws:lambda:${this.region}:${this.account}:function:gov-blueprint-*`],
      })
    );

    // NOTE: supportedVersions is effectively create-only — changing it requires gateway
    // replacement (hence logical ID 'GatewayV2').
    const gateway = new agentcore.CfnGateway(this, 'GatewayV2', {
      name: 'governance-blueprint-gw',
      description:
        'The stable contract: one endpoint, SigV4, semantic tool search. All capabilities live behind it.',
      authorizerType: 'AWS_IAM',
      protocolType: 'MCP',
      protocolConfiguration: {
        mcp: {
          searchType: 'SEMANTIC',
          // DevOps Agent negotiates 2025-03-26; modern IDE clients use 2025-06-18
          supportedVersions: ['2025-06-18', '2025-03-26'],
        },
      },
      roleArn: gatewayRole.roleArn,
      exceptionLevel: 'DEBUG',
    });

    // The catalog: scan capabilities/mcp/ and synthesize targets
    const capabilities = new Capabilities(this, 'Capabilities', {
      capabilitiesRoot: path.join(__dirname, '..', '..', 'capabilities'),
      gateway,
    });

    // Role that clients (DevOps Agent, IDEs) can assume to call the Gateway
    const invokeRole = new iam.Role(this, 'GatewayInvokeRole', {
      // DevOps Agent service principal is aidevops.amazonaws.com (per
      // "Creating an IAM role for SigV4 authentication" in the DevOps Agent user guide),
      // with confused-deputy protection via SourceAccount/SourceArn.
      assumedBy: new iam.ServicePrincipal('aidevops.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:aidevops:${this.region}:${this.account}:service/*` },
        },
      }),
      description: 'Assumed by DevOps Agent to call the Gateway with SigV4',
    });
    invokeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:InvokeGateway'],
        resources: [gateway.attrGatewayArn, `${gateway.attrGatewayArn}/*`],
      })
    );

    this.gatewayUrl = gateway.attrGatewayUrl;
    this.gatewayInvokeRoleArn = invokeRole.roleArn;
    this.toolNames = capabilities.toolNames;

    new cdk.CfnOutput(this, 'GatewayUrl', { value: this.gatewayUrl });
    new cdk.CfnOutput(this, 'GatewayInvokeRoleArn', { value: this.gatewayInvokeRoleArn });
    new cdk.CfnOutput(this, 'EnabledCapabilities', {
      value: capabilities.manifests.filter((m) => m.enabled).map((m) => m.name).join(', ') || '(none)',
    });
  }
}
