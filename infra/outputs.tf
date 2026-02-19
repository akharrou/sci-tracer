output "public_ip" {
  description = "The public IP address of the Sci-Trace EC2 instance."
  value       = aws_instance.sci_trace.public_ip
}

output "instance_id" {
  description = "The ID of the Sci-Trace EC2 instance."
  value       = aws_instance.sci_trace.id
}
