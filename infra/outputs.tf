output "public_ip" {
  # Expose the instance public IP after apply.
  description = "The public IP address of the Sci-Trace EC2 instance."
  value       = aws_instance.sci_trace.public_ip
}

output "instance_id" {
  # Expose the instance ID for automation or debugging.
  description = "The ID of the Sci-Trace EC2 instance."
  value       = aws_instance.sci_trace.id
}
