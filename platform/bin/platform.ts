#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { PlatformStack } from '../lib/platform-stack';
import { DevOpsAgentStack } from '../lib/devops-agent-stack';
import { ScenariosStack } from '../lib/scenarios-stack';
import { RemediationAgentStack } from '../lib/remediation-agent-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const platform = new PlatformStack(app, 'GovernanceBlueprint-Platform', {
  env,
  description: 'DevOps Agent Governance Blueprint - AgentCore Gateway + manifest-driven capability catalog',
});

const agent = new DevOpsAgentStack(app, 'GovernanceBlueprint-DevOpsAgent', {
  env,
  description: 'DevOps Agent Governance Blueprint - Agent Space + Gateway binding',
  gatewayUrl: platform.gatewayUrl,
  gatewayInvokeRoleArn: platform.gatewayInvokeRoleArn,
  toolNames: platform.toolNames,
});

new ScenariosStack(app, 'GovernanceBlueprint-Scenarios', {
  env,
  description: 'DevOps Agent Governance Blueprint - demo scenarios (alert glue, break/fix workload)',
  agentSpaceId: agent.agentSpaceId,
});

new RemediationAgentStack(app, 'GovernanceBlueprint-RemediationAgent', {
  env,
  description:
    'DevOps Agent Governance Blueprint - A2A remediation agent (AgentCore Runtime + AgentSpace association)',
  agentSpaceId: agent.agentSpaceId,
});

// Governance: every resource in every stack carries the project tag (override in cdk.json)
const projectTag = app.node.tryGetContext('projectTag') ?? 'devops-sample-poc';
cdk.Tags.of(app).add('Project', projectTag);
