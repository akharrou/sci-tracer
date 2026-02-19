provider "aws" {
  # Configure the target AWS region for all resources.
  region = var.aws_region
}

# --- VPC & Networking (Simplified for PoC) ---
# Assuming usage of default VPC for simplicity, but defining a security group.
resource "aws_security_group" "sci_trace_sg" {
  # Allow SSH in and all outbound traffic for the instance.
  name        = "${var.project_name}-sg"
  description = "Allow SSH and outbound traffic for Sci-Trace"

  ingress {
    description = "SSH from anywhere"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project_name}-sg"
  }
}

# --- AMI Lookup ---
data "aws_ami" "ubuntu_22_04" {
  # Look up the latest Ubuntu 22.04 LTS AMI in the region.
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# --- EC2 Instance ---
resource "aws_instance" "sci_trace" {
  # Provision the Sci-Trace EC2 instance.
  ami           = data.aws_ami.ubuntu_22_04.id
  instance_type = var.instance_type
  key_name      = var.key_name

  vpc_security_group_ids = [aws_security_group.sci_trace_sg.id]

  # Bootstrap the instance on first boot.
  user_data = file("${path.module}/user_data.sh")

  root_block_device {
    # Set the root volume size and type.
    volume_size = 20
    volume_type = "gp3"
  }

  tags = {
    Name = var.project_name
  }
}
