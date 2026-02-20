variable "aws_region" {
  # AWS region for all resources.
  description = "The AWS region to deploy the Sci-Trace instance."
  type        = string
  default     = "eu-central-1"
}

variable "instance_type" {
  # EC2 size for the host instance.
  description = "The EC2 instance type for the Sci-Trace host."
  type        = string
  default     = "t3.large"
}

variable "key_name" {
  # Existing AWS EC2 key pair name for SSH.
  description = "The name of the AWS key pair for SSH access."
  type        = string
}

variable "project_name" {
  # Tag prefix for all created resources.
  description = "The name of the project for resource tagging."
  type        = string
  default     = "sci-trace"
}
