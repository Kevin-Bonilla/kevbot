# OCI Logging resources for kevbot.
#
# Creates the log group and the custom log that the Unified Monitoring Agent on
# the VM writes into. The agent configuration itself — host group, log file
# path, JSON parser — is created in the Console or by API (see
# deploy/oci-logging/README.md step 3), because it has to reference the
# instance's dynamic group and the instance-local path.
#
# Creating the group/log here is an alternative to clicking through the
# Console. Either way, the names must match what the runbook says to select:
# log group `kevbot-logs`, log `kevbot-app`.
#
# Usage (from a machine with OCI API-key or session auth configured):
#   cd deploy/tf
#   terraform init
#   terraform plan  -var='compartment_id=ocid1.compartment.oc1..xxx'
#   terraform apply -var='compartment_id=ocid1.compartment.oc1..xxx'
#
# Note: Terraform only creates the destination. Nothing is ingested until the
# agent on the VM is installed and its agent configuration points at
# /opt/kevbot/logs/kevbot.log.

terraform {
  required_providers {
    oci = {
      source = "oracle/oci"
    }
  }
}

variable "compartment_id" {
  description = "OCID of the compartment where the log group and log live."
  type        = string
}

variable "retention_days" {
  description = "Log retention, in 30-day increments from 30 to 180."
  type        = number
  default     = 30

  validation {
    condition     = var.retention_days >= 30 && var.retention_days <= 180 && var.retention_days % 30 == 0
    error_message = "retention_days must be a multiple of 30 between 30 and 180."
  }
}

resource "oci_logging_log_group" "kevbot" {
  compartment_id = var.compartment_id
  display_name   = "kevbot-logs"
  description    = "Log group for the kevbot Discord bot on the OCI Always Free VM."
}

# A CUSTOM log is a destination, not a source: it takes no configuration block.
# The Unified Monitoring Agent is pointed at it by its agent configuration, and
# that configuration is what supplies the file path and parser.
resource "oci_logging_log" "kevbot_app" {
  log_group_id       = oci_logging_log_group.kevbot.id
  display_name       = "kevbot-app"
  log_type           = "CUSTOM"
  is_enabled         = true
  retention_duration = var.retention_days
}

output "log_group_id" {
  description = "Log group OCID; matches the Console Log Group picker."
  value       = oci_logging_log_group.kevbot.id
}

output "log_id" {
  description = "Custom log OCID; matches the Console 'Log name' picker."
  value       = oci_logging_log.kevbot_app.id
}
