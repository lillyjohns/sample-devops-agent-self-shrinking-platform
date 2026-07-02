#!/usr/bin/env python3
"""End-to-end smoke test for the deployed Governance Blueprint.

Talks to the live AgentCore Gateway exactly the way DevOps Agent does:
SigV4-signed Streamable-HTTP MCP calls. Reads the Gateway URL from the
CloudFormation stack outputs, so no arguments are needed.

Checks:
  1. CloudFormation stacks are healthy
  2. MCP initialize handshake (protocol 2025-06-18)
  3. tools/list exposes every catalog tool + semantic search
  4. tools/call find_cost_waste returns a well-formed result
  5. tools/call generate_cost_report returns a presigned artifact URL
  6. (--plant-waste) plants an unattached EBS volume, verifies detection, cleans up

Usage:
  python3 scripts/e2e_test.py [--region ap-northeast-1] [--plant-waste]

Exit code 0 = all checks passed.
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request

import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

PLATFORM_STACK = "GovernanceBlueprint-Platform"
AGENT_STACK = "GovernanceBlueprint-DevOpsAgent"
MCP_VERSION = "2025-06-18"
EXPECTED_TOOLS = {
    "x_amz_bedrock_agentcore_search",
    "find-cost-waste___find_cost_waste",
    "generate-report___generate_cost_report",
}

passed = 0
failed = 0


def check(name: str, ok: bool, detail: str = "") -> bool:
    global passed, failed
    mark = "PASS" if ok else "FAIL"
    print(f"[{mark}] {name}" + (f" — {detail}" if detail else ""))
    if ok:
        passed += 1
    else:
        failed += 1
    return ok


class GatewayClient:
    def __init__(self, url: str, region: str):
        self.url = url
        self.region = region
        creds = boto3.Session().get_credentials()
        if creds is None:
            print("No AWS credentials found — set AWS_* env vars or a profile.")
            sys.exit(2)
        self.creds = creds.get_frozen_credentials()

    def call(self, method: str, params=None, req_id=1, timeout=120):
        body = json.dumps(
            {"jsonrpc": "2.0", "id": req_id, "method": method, "params": params or {}}
        )
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": MCP_VERSION,
        }
        req = AWSRequest(method="POST", url=self.url, data=body, headers=headers)
        SigV4Auth(self.creds, "bedrock-agentcore", self.region).add_auth(req)
        http_req = urllib.request.Request(
            self.url, data=body.encode(), headers=dict(req.headers), method="POST"
        )
        try:
            with urllib.request.urlopen(http_req, timeout=timeout) as resp:
                raw = resp.read().decode()
        except urllib.error.HTTPError as e:
            return {"_http_error": e.code, "_body": e.read().decode()[:500]}
        # Streamable HTTP may answer as SSE or plain JSON
        if "data:" in raw and not raw.lstrip().startswith("{"):
            for line in raw.splitlines():
                if line.startswith("data:"):
                    return json.loads(line[5:].strip())
        return json.loads(raw)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--region", default="ap-northeast-1")
    ap.add_argument(
        "--plant-waste",
        action="store_true",
        help="create a temporary unattached EBS volume to verify waste detection (costs <$0.01)",
    )
    args = ap.parse_args()

    cfn = boto3.client("cloudformation", region_name=args.region)

    # 1. Stack health
    gateway_url = None
    for stack in (PLATFORM_STACK, AGENT_STACK):
        try:
            desc = cfn.describe_stacks(StackName=stack)["Stacks"][0]
            status = desc["StackStatus"]
            check(f"stack {stack} healthy", status.endswith("_COMPLETE") and "ROLLBACK" not in status, status)
            if stack == PLATFORM_STACK:
                outputs = {o["OutputKey"]: o["OutputValue"] for o in desc.get("Outputs", [])}
                gateway_url = outputs.get("GatewayUrl")
        except Exception as e:  # noqa: BLE001
            check(f"stack {stack} healthy", False, str(e))
    if not gateway_url:
        check("GatewayUrl output present", False)
        return 1
    check("GatewayUrl output present", True, gateway_url)

    gw = GatewayClient(gateway_url, args.region)

    # 2. initialize
    r = gw.call(
        "initialize",
        {"protocolVersion": MCP_VERSION, "capabilities": {}, "clientInfo": {"name": "e2e", "version": "1.0"}},
    )
    ok = bool(r and r.get("result", {}).get("protocolVersion") == MCP_VERSION)
    check("MCP initialize handshake", ok, json.dumps(r)[:200] if not ok else "")

    # 3. tools/list
    r = gw.call("tools/list", req_id=2)
    tools = {t["name"] for t in r.get("result", {}).get("tools", [])} if r else set()
    check("tools/list exposes catalog", EXPECTED_TOOLS.issubset(tools), f"got {sorted(tools)}")

    # 4. find_cost_waste
    r = gw.call(
        "tools/call",
        {"name": "find-cost-waste___find_cost_waste", "arguments": {"checks": ["unattached_ebs", "gp2_volumes"]}},
        req_id=3,
    )
    body = None
    ok = bool(r and not r.get("result", {}).get("isError"))
    if ok:
        body = json.loads(r["result"]["content"][0]["text"])
        ok = "findings" in body and "summary" in body
    check("find_cost_waste returns well-formed result", ok, json.dumps(r)[:200] if not ok else f"{body['summary']['count']} findings")

    # 5. generate_cost_report
    r = gw.call("tools/call", {"name": "generate-report___generate_cost_report", "arguments": {"days": 7}}, req_id=4)
    ok = bool(r and not r.get("result", {}).get("isError"))
    url = None
    if ok:
        body = json.loads(r["result"]["content"][0]["text"])
        url = body.get("report_url")
        ok = bool(url and url.startswith("https://"))
    if ok:
        try:
            with urllib.request.urlopen(url, timeout=30) as resp:
                head = resp.read(200).decode()
            ok = "," in head  # CSV sanity
        except Exception as e:  # noqa: BLE001
            ok, head = False, str(e)
    check("generate_cost_report returns downloadable CSV", ok)

    # 6. optional waste-detection round trip
    if args.plant_waste:
        ec2 = boto3.client("ec2", region_name=args.region)
        az = ec2.describe_availability_zones()["AvailabilityZones"][0]["ZoneName"]
        vol = ec2.create_volume(
            AvailabilityZone=az,
            Size=8,
            VolumeType="gp2",
            TagSpecifications=[{
                "ResourceType": "volume",
                "Tags": [
                    {"Key": "Project", "Value": "devops-sample-poc"},
                    {"Key": "Purpose", "Value": "e2e-waste-detection"},
                ],
            }],
        )["VolumeId"]
        try:
            ec2.get_waiter("volume_available").wait(VolumeIds=[vol])
            time.sleep(5)
            r = gw.call(
                "tools/call",
                {"name": "find-cost-waste___find_cost_waste", "arguments": {"checks": ["unattached_ebs"]}},
                req_id=5,
            )
            body = json.loads(r["result"]["content"][0]["text"])
            found = any(vol in f.get("resource_arn", "") for f in body.get("findings", []))
            check("planted EBS volume detected as waste", found, vol)
        finally:
            ec2.delete_volume(VolumeId=vol)
            print(f"       cleaned up {vol}")

    print(f"\n{passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
