import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { Construct } from 'constructs';
import * as path from 'path';

export interface RemediationAgentStackProps extends cdk.StackProps {
  /** AgentSpace to associate the remote agent with. */
  agentSpaceId: string;
}

/** AgentRuntimeName pattern is [a-zA-Z][a-zA-Z0-9_]{0,47} — underscores, no hyphens. */
const RUNTIME_NAME = 'remediation_pr_agent';

/** Registered remote-agent name (shows up in DevOps Agent delegation). */
const REMOTE_AGENT_NAME = 'remediation-pr-agent';

/** Lambda that performs the governed write (see capabilities/mcp/propose-fix-pr). */
const PROPOSE_FIX_PR_FUNCTION = 'gov-blueprint-propose-fix-pr';

/**
 * The A2A graduation path made real (capabilities/a2a/remediation-pr-agent):
 *
 *  - AgentCore Runtime (protocol A2A, CodeConfiguration zip — no container)
 *    running the minimal remediation agent
 *  - IAM: runtime execution role (invokes the propose-fix-pr Lambda) and a
 *    SigV4 invoke role for DevOps Agent (aidevops.amazonaws.com principal
 *    with confused-deputy conditions, mirroring the Gateway invoke role)
 *  - Registration + Association with the AgentSpace as `remoteagentsigv4`.
 *    The AWS::DevOpsAgent::Service/Association CFN types don't support the
 *    remoteagent* service types yet (verified against the registry schemas,
 *    2026-07), so a small custom resource drives RegisterService /
 *    AssociateService / DisassociateService / DeregisterService — the
 *    lifecycle stays fully in CloudFormation.
 */
export class RemediationAgentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RemediationAgentStackProps) {
    super(scope, id, props);

    // --- Agent code as a zip asset (CodeConfiguration — no container build) ---
    const agentAsset = new s3assets.Asset(this, 'AgentCode', {
      path: path.join(
        __dirname, '..', '..', 'capabilities', 'a2a', 'remediation-pr-agent', 'agent'
      ),
    });

    // --- Runtime execution role ---
    const runtimeRole = new iam.Role(this, 'RuntimeRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: {
            'aws:SourceArn': `arn:aws:bedrock-agentcore:${this.region}:${this.account}:*`,
          },
        },
      }),
      description: 'Execution role for the remediation-pr-agent AgentCore Runtime',
    });
    // The agent's ONLY power: invoke the governed propose-fix-pr Lambda.
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [
          `arn:aws:lambda:${this.region}:${this.account}:function:${PROPOSE_FIX_PR_FUNCTION}`,
        ],
      })
    );
    // Housekeeping the runtime needs: code download, logs, traces, metrics, identity.
    agentAsset.grantRead(runtimeRole);
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
          'logs:DescribeLogGroups',
          'logs:DescribeLogStreams',
          'xray:PutTraceSegments',
          'xray:PutTelemetryRecords',
        ],
        resources: ['*'],
      })
    );
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } },
      })
    );
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock-agentcore:GetWorkloadAccessToken',
          'bedrock-agentcore:GetWorkloadAccessTokenForJWT',
          'bedrock-agentcore:GetWorkloadAccessTokenForUserId',
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default`,
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default/workload-identity/${RUNTIME_NAME}-*`,
        ],
      })
    );

    // --- The A2A runtime ---
    const runtime = new agentcore.CfnRuntime(this, 'Runtime', {
      agentRuntimeName: RUNTIME_NAME,
      description:
        'Remediation PR agent (A2A): proposes runbook-approved IaC fixes for cost findings as GitHub PRs',
      agentRuntimeArtifact: {
        codeConfiguration: {
          code: {
            s3: { bucket: agentAsset.s3BucketName, prefix: agentAsset.s3ObjectKey },
          },
          runtime: 'PYTHON_3_13',
          entryPoint: ['agent.py'],
        },
      },
      roleArn: runtimeRole.roleArn,
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: 'A2A',
      environmentVariables: {
        PROPOSE_FIX_PR_FUNCTION,
        DEFAULT_FILE_PATH: 'scenarios/demo-workload/template.yaml',
      },
    });
    runtime.node.addDependency(runtimeRole);

    // --- SigV4 invoke role for DevOps Agent (mirrors the Gateway invoke role) ---
    const invokeRole = new iam.Role(this, 'AgentInvokeRole', {
      assumedBy: new iam.ServicePrincipal('aidevops.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:aidevops:${this.region}:${this.account}:service/*` },
        },
      }),
      description: 'Assumed by DevOps Agent to invoke the remediation A2A agent with SigV4',
    });
    invokeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:InvokeAgentRuntime'],
        resources: [runtime.attrAgentRuntimeArn, `${runtime.attrAgentRuntimeArn}/*`],
      })
    );

    // --- Registration + association custom resource ---
    const registrarFn = new lambda.Function(this, 'RegistrarFn', {
      functionName: 'gov-blueprint-remote-agent-registrar',
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '..', 'custom-resources', 'remote-agent-registration')
      ),
      timeout: cdk.Duration.minutes(2),
      description:
        'CFN custom resource: registers/associates the remediation A2A agent with DevOps Agent (remoteagentsigv4)',
      logGroup: new logs.LogGroup(this, 'RegistrarLogs', {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    registrarFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'aidevops:RegisterService',
          'aidevops:DeregisterService',
          'aidevops:AssociateService',
          'aidevops:DisassociateService',
          'aidevops:TagResource',
        ],
        resources: ['*'],
      })
    );
    // RegisterService carries the invoke role ARN — the control plane requires PassRole.
    registrarFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [invokeRole.roleArn],
      })
    );

    const registration = new cdk.CustomResource(this, 'RemoteAgentRegistration', {
      serviceToken: registrarFn.functionArn,
      resourceType: 'Custom::DevOpsAgentRemoteAgent',
      properties: {
        AgentSpaceId: props.agentSpaceId,
        Name: REMOTE_AGENT_NAME,
        // The A2A endpoint is the AgentCore data-plane URL for this runtime;
        // the handler URL-encodes the ARN and appends /invocations/.
        RuntimeArn: runtime.attrAgentRuntimeArn,
        Description:
          'Remediation agent for cost-waste findings - opens runbook-approved fix PRs (write-as-proposal)',
        SigningRegion: this.region,
        SigningService: 'bedrock-agentcore',
        InvokeRoleArn: invokeRole.roleArn,
      },
    });
    registration.node.addDependency(runtime);

    new cdk.CfnOutput(this, 'RuntimeArn', { value: runtime.attrAgentRuntimeArn });
    new cdk.CfnOutput(this, 'RemoteAgentServiceId', {
      value: registration.getAttString('ServiceId'),
    });
    new cdk.CfnOutput(this, 'RemoteAgentAssociationId', {
      value: registration.getAttString('AssociationId'),
    });
  }
}
