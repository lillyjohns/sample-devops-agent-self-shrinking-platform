"""CloudFormation custom resource: register + associate a remote A2A agent.

AWS::DevOpsAgent::Service / ::Association CFN types don't cover the
remoteagent/remoteagentsigv4 service types yet (verified against the CFN
registry schemas, 2026-07 — see docs/DESIGN.md), so this Lambda bridges the
gap with the control-plane API while keeping the whole lifecycle in IaC:

  Create -> RegisterService(remoteagentsigv4) + AssociateService
  Update -> replace (new registration; CFN deletes the old physical resource)
  Delete -> DisassociateService + DeregisterService

The devops-agent service model is bundled under models/ and loaded via
AWS_DATA_PATH (same trick as scenarios/alert-glue) because Lambda's boto3
may not know the service or the remote-agent shapes yet.
"""

import json
import os
import urllib.parse
import urllib.request

os.environ.setdefault(
    "AWS_DATA_PATH", os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
)

import boto3  # noqa: E402  (AWS_DATA_PATH must be set first)


def _client():
    return boto3.client("devops-agent", region_name=os.environ["AWS_REGION"])


def _endpoint(props):
    """AgentCore Runtime A2A data-plane URL for the runtime ARN."""
    if props.get("Endpoint"):
        return props["Endpoint"]
    arn = props["RuntimeArn"]
    region = arn.split(":")[3]
    escaped = urllib.parse.quote(arn, safe="")
    return f"https://bedrock-agentcore.{region}.amazonaws.com/runtimes/{escaped}/invocations/"


def _create(props):
    c = _client()
    reg = c.register_service(
        service="remoteagentsigv4",
        name=props["Name"],
        serviceDetails={
            "remoteagentsigv4": {
                "name": props["Name"],
                "endpoint": _endpoint(props),
                "description": props.get("Description", "")[:256]
                or "Remote A2A agent",
                "authorizationConfig": {
                    "region": props["SigningRegion"],
                    "service": props["SigningService"],
                    "roleArn": props["InvokeRoleArn"],
                },
            }
        },
        tags={"Project": os.environ.get("PROJECT_TAG", "devops-sample-poc")},
    )
    service_id = reg["serviceId"]
    try:
        assoc = c.associate_service(
            agentSpaceId=props["AgentSpaceId"],
            serviceId=service_id,
            configuration={"remoteagentsigv4": {}},
        )
        association_id = assoc["association"]["associationId"]
    except Exception:
        # Roll back the registration so failed stacks don't leak services.
        try:
            c.deregister_service(serviceId=service_id)
        except Exception as e:  # best effort
            print(f"rollback deregister failed: {e}")
        raise
    return service_id, association_id


def _delete(physical_id, props):
    c = _client()
    service_id, _, association_id = physical_id.partition("|")
    if association_id:
        try:
            c.disassociate_service(
                agentSpaceId=props["AgentSpaceId"], associationId=association_id
            )
        except Exception as e:
            print(f"disassociate failed (continuing): {e}")
    if service_id and service_id != "FAILED":
        try:
            c.deregister_service(serviceId=service_id)
        except Exception as e:
            print(f"deregister failed (continuing): {e}")


def handler(event, context):
    print(json.dumps({k: v for k, v in event.items() if k != "ResponseURL"}))
    props = event.get("ResourceProperties", {})
    status, reason, data = "SUCCESS", "", {}
    physical_id = event.get("PhysicalResourceId", "FAILED")
    try:
        if event["RequestType"] in ("Create", "Update"):
            service_id, association_id = _create(props)
            physical_id = f"{service_id}|{association_id}"
            data = {"ServiceId": service_id, "AssociationId": association_id}
        elif event["RequestType"] == "Delete":
            _delete(physical_id, props)
    except Exception as e:
        status, reason = "FAILED", str(e)[:1000]
        print(f"ERROR: {e}")

    body = json.dumps(
        {
            "Status": status,
            "Reason": reason or f"see {context.log_stream_name}",
            "PhysicalResourceId": physical_id,
            "StackId": event["StackId"],
            "RequestId": event["RequestId"],
            "LogicalResourceId": event["LogicalResourceId"],
            "Data": data,
        }
    ).encode()
    req = urllib.request.Request(
        event["ResponseURL"], data=body, method="PUT",
        headers={"Content-Type": ""},
    )
    urllib.request.urlopen(req, timeout=30)
    return status
