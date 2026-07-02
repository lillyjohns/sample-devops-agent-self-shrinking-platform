/**
 * Synth assertion tests — verify the deployed shape of both stacks without
 * touching AWS. Encodes every hard-won deployment finding as a regression test.
 */
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { PlatformStack } from '../lib/platform-stack';
import { DevOpsAgentStack } from '../lib/devops-agent-stack';
import { MCP_SERVER_NAME, MAX_COMBINED_TOOL_NAME, GATEWAY_SEARCH_TOOL } from '../lib/constants';

const ENV = { account: '111111111111', region: 'ap-northeast-1' };

function synth() {
  const app = new cdk.App({ context: { projectTag: 'devops-sample-poc' } });
  const platform = new PlatformStack(app, 'TestPlatform', { env: ENV });
  const agent = new DevOpsAgentStack(app, 'TestAgent', {
    env: ENV,
    gatewayUrl: platform.gatewayUrl,
    gatewayInvokeRoleArn: platform.gatewayInvokeRoleArn,
    toolNames: platform.toolNames,
  });
  cdk.Tags.of(app).add('Project', 'devops-sample-poc');
  return {
    platform: Template.fromStack(platform),
    agent: Template.fromStack(agent),
    platformStack: platform,
  };
}

describe('PlatformStack', () => {
  const { platform, platformStack } = synth();

  test('creates exactly one Gateway with IAM auth and semantic search', () => {
    platform.resourceCountIs('AWS::BedrockAgentCore::Gateway', 1);
    platform.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
      AuthorizerType: 'AWS_IAM',
      ProtocolType: 'MCP',
      ProtocolConfiguration: {
        Mcp: Match.objectLike({ SearchType: 'SEMANTIC' }),
      },
    });
  });

  test('Gateway supports both MCP protocol versions (DevOps Agent needs 2025-03-26)', () => {
    platform.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
      ProtocolConfiguration: {
        Mcp: Match.objectLike({
          SupportedVersions: Match.arrayWith(['2025-06-18', '2025-03-26']),
        }),
      },
    });
  });

  test('creates one Gateway target per enabled lambda capability', () => {
    platform.resourceCountIs('AWS::BedrockAgentCore::GatewayTarget', 2);
  });

  test('all targets use GATEWAY_IAM_ROLE credentials (no secrets on the shared plane)', () => {
    const targets = platform.findResources('AWS::BedrockAgentCore::GatewayTarget');
    for (const t of Object.values(targets)) {
      expect(t.Properties.CredentialProviderConfigurations).toEqual([
        { CredentialProviderType: 'GATEWAY_IAM_ROLE' },
      ]);
    }
  });

  test('gateway invoke role trusts aidevops.amazonaws.com with confused-deputy conditions', () => {
    platform.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'aidevops.amazonaws.com' },
            Condition: Match.objectLike({
              StringEquals: { 'aws:SourceAccount': ENV.account },
              ArnLike: {
                'aws:SourceArn': `arn:aws:aidevops:${ENV.region}:${ENV.account}:service/*`,
              },
            }),
          }),
        ]),
      }),
    });
  });

  test('gateway execution role can only invoke gov-blueprint-* lambdas', () => {
    platform.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'lambda:InvokeFunction',
            Resource: `arn:aws:lambda:${ENV.region}:${ENV.account}:function:gov-blueprint-*`,
          }),
        ]),
      }),
    });
  });

  test('capability lambdas carry only read-only IAM actions (plus artifact bucket)', () => {
    const policies = platform.findResources('AWS::IAM::Policy');
    const WRITE = /^(ec2|ce|cloudwatch|pricing|rds|iam):(Create|Put|Delete|Update|Modify|Terminate|Stop|Reboot|Attach|Detach)/;
    for (const p of Object.values(policies)) {
      for (const stmt of p.Properties.PolicyDocument.Statement) {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        for (const a of actions) {
          if (typeof a === 'string') expect(a).not.toMatch(WRITE);
        }
      }
    }
  });

  test('artifact bucket blocks public access and enforces SSL', () => {
    platform.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    platform.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      }),
    });
  });

  test('every taggable resource carries Project=devops-sample-poc', () => {
    // Known exception: the S3 auto-delete custom-resource provider (framework
    // singleton) is a raw CfnResource without a TagManager, so the Tags aspect
    // cannot reach it. All app-defined capability lambdas must be tagged.
    const fns = platform.findResources('AWS::Lambda::Function');
    const appFns = Object.values(fns).filter((f) =>
      String(f.Properties.FunctionName ?? '').startsWith('gov-blueprint-')
    );
    expect(appFns.length).toBe(2);
    for (const r of [...appFns, ...Object.values(platform.findResources('AWS::S3::Bucket'))]) {
      expect(r.Properties.Tags).toEqual(
        expect.arrayContaining([{ Key: 'Project', Value: 'devops-sample-poc' }])
      );
    }
    // IAM roles with a tag manager (all app-defined roles) must be tagged too.
    const roles = Object.values(platform.findResources('AWS::IAM::Role'));
    const tagged = roles.filter((r) => r.Properties.Tags);
    expect(tagged.length).toBeGreaterThanOrEqual(4); // gateway, invoke, 2 lambda exec roles
    for (const r of tagged) {
      expect(r.Properties.Tags).toEqual(
        expect.arrayContaining([{ Key: 'Project', Value: 'devops-sample-poc' }])
      );
    }
  });

  test('all catalog tool names respect the DevOps Agent 64-char combined limit', () => {
    expect(platformStack.toolNames.length).toBeGreaterThanOrEqual(2);
    for (const tool of platformStack.toolNames) {
      expect(`${MCP_SERVER_NAME}_${tool}`.length).toBeLessThanOrEqual(MAX_COMBINED_TOOL_NAME);
    }
  });
});

describe('DevOpsAgentStack', () => {
  const { agent } = synth();

  test('creates AgentSpace, Service, and Association', () => {
    agent.resourceCountIs('AWS::DevOpsAgent::AgentSpace', 1);
    agent.resourceCountIs('AWS::DevOpsAgent::Service', 1);
    agent.resourceCountIs('AWS::DevOpsAgent::Association', 1);
  });

  test('Service registers the Gateway via SigV4 with the short server name', () => {
    agent.hasResourceProperties('AWS::DevOpsAgent::Service', {
      ServiceType: 'mcpserversigv4',
      ServiceDetails: {
        MCPServerSigV4: Match.objectLike({
          Name: MCP_SERVER_NAME,
          AuthorizationConfig: Match.objectLike({ Service: 'bedrock-agentcore' }),
        }),
      },
    });
  });

  test('Association allowlists the catalog tools plus semantic search (derived, not hardcoded)', () => {
    agent.hasResourceProperties('AWS::DevOpsAgent::Association', {
      Configuration: {
        MCPServerSigV4: {
          Tools: Match.arrayWith([
            GATEWAY_SEARCH_TOOL,
            'find-cost-waste___find_cost_waste',
            'generate-report___generate_cost_report',
          ]),
        },
      },
    });
  });
});
