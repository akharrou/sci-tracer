variable "aws_region" {
  description = "The AWS region to deploy the Sci-Trace instance."
  type        = string
  default     = "us-east-1"
}

variable "instance_type" {
  description = "The EC2 instance type for the Sci-Trace host."
  type        = string
  default     = "t3.medium"
}

variable "key_name" {
  description = "The name of the AWS key pair for SSH access."
  type        = string
}

variable "project_name" {
  description = "The name of the project for resource tagging."
  type        = string
  default     = "sci-trace"
}
