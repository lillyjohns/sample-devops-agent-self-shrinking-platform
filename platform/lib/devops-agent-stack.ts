import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { MCP_SERVER_NAME, GATEWAY_SEARCH_TOOL } from './constants';

export interface DevOpsAgentStackProps extends cdk.StackProps {
  gatewayUrl: string;
  gatewayInvokeRoleArn: string;
  /** Gateway tool names to allowlist for this Agent Space (derived from the catalog). */
  toolNames: string[];
}

/**
 * Binds AWS DevOps Agent to the platform:
 *  - AgentSpace (the workspace)
 *  - Service of type mcpserversigv4 pointing at the Gateway (the one-time binding
 *    that never changes — everything behind the Gateway is pluggable)
 *  - Association linking the two
 *
 * Uses Cfn L1s via CfnResource because AWS::DevOpsAgent::* has no L2 yet.
 */
export class DevOpsAgentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DevOpsAgentStackProps) {
    super(scope, id, props);

    const agentSpace = new cdk.CfnResource(this, 'AgentSpace', {
      type: 'AWS::DevOpsAgent::AgentSpace',
      properties: {
        Name: this.node.tryGetContext('agentSpaceName') ?? 'governance-blueprint',
        Description:
          'DevOps Agent Governance Blueprint - cost optimization reference implementation',
      },
    });

    const gatewayService = new cdk.CfnResource(this, 'GatewayService', {
      type: 'AWS::DevOpsAgent::Service',
      properties: {
        ServiceType: 'mcpserversigv4',
        ServiceDetails: {
          MCPServerSigV4: {
            // Keep short: DevOps Agent enforces len(serverName + '_' + toolName) <= 64
            Name: MCP_SERVER_NAME,
            Endpoint: props.gatewayUrl,
            Description:
              'Platform capability Gateway - all governed tools are discovered through this single endpoint',
            AuthorizationConfig: {
              Region: this.region,
              Service: 'bedrock-agentcore',
              RoleArn: props.gatewayInvokeRoleArn,
            },
          },
        },
      },
    });

    new cdk.CfnResource(this, 'GatewayAssociation', {
      type: 'AWS::DevOpsAgent::Association',
      properties: {
        AgentSpaceId: agentSpace.getAtt('AgentSpaceId').toString(),
        ServiceId: gatewayService.getAtt('ServiceId').toString(),
        // Governance: explicit tool allowlist per Agent Space, derived from the
        // capability catalog at synth time (semantic search tool included so
        // DevOps Agent can discover new capabilities as they are added).
        Configuration: {
          MCPServerSigV4: {
            Tools: [GATEWAY_SEARCH_TOOL, ...props.toolNames],
          },
        },
      },
    });

    new cdk.CfnOutput(this, 'AgentSpaceId', {
      value: agentSpace.getAtt('AgentSpaceId').toString(),
    });
  }
}
