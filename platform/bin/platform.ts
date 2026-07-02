#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { PlatformStack } from '../lib/platform-stack';
import { DevOpsAgentStack } from '../lib/devops-agent-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const platform = new PlatformStack(app, 'GovernanceBlueprint-Platform', {
  env,
  description: 'DevOps Agent Governance Blueprint - AgentCore Gateway + manifest-driven capability catalog',
});

new DevOpsAgentStack(app, 'GovernanceBlueprint-DevOpsAgent', {
  env,
  description: 'DevOps Agent Governance Blueprint - Agent Space + Gateway binding',
  gatewayUrl: platform.gatewayUrl,
  gatewayInvokeRoleArn: platform.gatewayInvokeRoleArn,
  toolNames: platform.toolNames,
});

// Governance: every resource in every stack carries the project tag (override in cdk.json)
const projectTag = app.node.tryGetContext('projectTag') ?? 'devops-sample-poc';
cdk.Tags.of(app).add('Project', projectTag);
