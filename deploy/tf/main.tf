# OCI Logging resources for kevbot.
#
# Provisions a log group, a log that ingests from the kevbot compute instance's
# logging agent, and alerting policies for the log patterns you care about.
#
# Prerequisites:
#   1. The Unified Monitoring (logging agent) must be installed and running on
#      the compute instance (see deploy/oci-setup.sh).
#   2. The instance must have the `log-collection` and `logging-agent` IAM
#      policies (or the dynamic group + policy) to emit logs to this compartment.
#
# Usage (on a machine with the OCI CLI configured):
#   cd deploy/tf
#   terraform init
#   terraform plan -var='compartment_id=ocid1.compartment.oc1..xxx' \
#                  -var='kevbort_vm_id=ocid1.instance.oc1..xxx' \
#   terraform apply -var='compartment_id=ocid1.compartment.oc1..xxx' \
#                   -var='kevbort_vm_id=ocid1.instance.oc1..xxx'

variable "compartment_id" {
  description = "OCID of the compartment where logging resources will live."
  type        = string
}

variable "kevbort_vm_id" {
  description = "OCID of the kevbot compute instance (used as the log source)."
  type        = string
}

variable "notification_topic_arn" {
  description = "Optional: OCID of an OCI Notifications topic for alerts. If empty, alerts are silent (still visible in the Logging console)."
  type        = string
  default     = ""
}

# --- Log group ---
resource "oci_logging_log_group" "kevbot" {
  compartment_id = var.compartment_id
  display_name   = "kevbot"
  description    = "Log group for the kevbot Discord bot on OCI Always Free VM."
}

# --- Log: ingests from the logging agent on the kevbot VM ---
resource "oci_logging_log" "kevbot_vm_log" {
  log_group_identifier = oci_logging_log_group.kevbot.id
  display_name         = "kevbot-vm"
  description          = "Captures journald stdout/stderr from the kevbot systemd service on the compute instance."
  log_type             = "CUSTOM"
  is_enabled           = true
  retention_duration   = 30  # days

  source {
    source_type = "LOGGING_AGENT"
    parameters  = {}
  }
}

# --- Alert: bot went offline ---
# Matches any log line containing "KEVBOT is OFFLINE" or "Gateway disconnected".
resource "oci_logging_alarm" "kevbot_offline" {
  compartment_id = var.compartment_id
  display_name   = "kevbot-offline"
  is_enabled     = var.notification_topic_arn != ""

  metric_name   = "kevbot_offline"
  namespace     = "kevbot_monitoring"
  query_text    = "Search [${oci_logging_log.kevbot_vm_log.id}] where (request.message = 'KEVBOT is OFFLINE' OR request.message = 'Gateway disconnected') | count 1"

  severity        = "CRITICAL"
  body            = "kevbot went offline or lost its Discord gateway connection. Check journalctl -u kevbot -f on the VM."
  message_format  = "PREDEFINED_TEMPLATE"
  threshold       { type = "THRESHOLD", operator = "GREATER_THAN_OR_EQUAL_TO", value = 1 }
  scan_period     = "PT5M"

  notification_details {
    topic_id = var.notification_topic_arn != "" ? var.notification_topic_arn : null
  }
}

# --- Alert: uncaught exception ---
resource "oci_logging_alarm" "kevbot_uncaught_exception" {
  compartment_id = var.compartment_id
  display_name   = "kevbot-uncaught-exception"
  is_enabled     = var.notification_topic_arn != ""

  metric_name   = "kevbot_uncaught_exception"
  namespace     = "kevbot_monitoring"
  query_text    = "Search [${oci_logging_log.kevbot_vm_log.id}] where request.message = 'Uncaught exception' | count 1"

  severity        = "CRITICAL"
  body            = "kevbot hit an uncaught exception. Check the kevbot logs for the full stack trace."
  message_format  = "PREDEFINED_TEMPLATE"
  threshold       { type = "THRESHOLD", operator = "GREATER_THAN_OR_EQUAL_TO", value = 1 }
  scan_period     = "PT5M"

  notification_details {
    topic_id = var.notification_topic_arn != "" ? var.notification_topic_arn : null
  }
}

# --- Alert: unhandled promise rejection ---
resource "oci_logging_alarm" "kevbot_unhandled_rejection" {
  compartment_id = var.compartment_id
  display_name   = "kevbot-unhandled-rejection"
  is_enabled     = var.notification_topic_arn != ""

  metric_name   = "kevbot_unhandled_rejection"
  namespace     = "kevbot_monitoring"
  query_text    = "Search [${oci_logging_log.kevbot_vm_log.id}] where request.message = 'Unhandled promise rejection' | count 1"

  severity        = "CRITICAL"
  body            = "kevbot hit an unhandled promise rejection. Investigate and restart the service."
  message_format  = "PREDEFINED_TEMPLATE"
  threshold       { type = "THRESHOLD", operator = "GREATER_THAN_OR_EQUAL_TO", value = 1 }
  scan_period     = "PT5M"

  notification_details {
    topic_id = var.notification_topic_arn != "" ? var.notification_topic_arn : null
  }
}