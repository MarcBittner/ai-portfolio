###############################################################################
# rate-atlas — ILLUSTRATIVE Terraform skeleton ("what I'd build").
#
# NOT applied anywhere: the live demo runs on Render's free tier. This sketches
# the AWS platform a Platform Ops role would own to run the same container at
# scale — a VPC, an EKS cluster for the stateless API, and an RDS Postgres for
# the canonical rate store (the SQLite stand-in becomes managed Postgres with
# the schema/index/queries unchanged). Module bodies are intentionally elided;
# the shape is the point. `terraform validate` is not expected to pass without
# the referenced modules.
###############################################################################

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  # Remote state — S3 + DynamoDB lock (per-environment key).
  backend "s3" {
    bucket         = "marc-portfolio-tfstate"
    key            = "rate-atlas/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "terraform-locks"
    encrypt        = true
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      project = "rate-atlas"
      owner   = "platform-ops"
      managed = "terraform"
    }
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "environment" {
  type    = string
  default = "prod"
}

# --- Network -----------------------------------------------------------------
module "vpc" {
  source = "terraform-aws-modules/vpc/aws"

  name            = "rate-atlas-${var.environment}"
  cidr            = "10.40.0.0/16"
  azs             = ["${var.region}a", "${var.region}b", "${var.region}c"]
  private_subnets = ["10.40.1.0/24", "10.40.2.0/24", "10.40.3.0/24"]
  public_subnets  = ["10.40.101.0/24", "10.40.102.0/24", "10.40.103.0/24"]

  enable_nat_gateway = true
  single_nat_gateway = var.environment != "prod" # one NAT in non-prod to save cost
}

# --- IAM: IRSA so pods assume scoped roles, no long-lived keys ---------------
module "irsa_rate_atlas" {
  source = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"

  role_name = "rate-atlas-${var.environment}"
  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["rate-atlas:rate-atlas"]
    }
  }
  # Scope: read the RDS connection secret + Parameter Store; nothing more.
  role_policy_arns = {
    secrets = aws_iam_policy.read_db_secret.arn
  }
}

resource "aws_iam_policy" "read_db_secret" {
  name = "rate-atlas-read-db-secret-${var.environment}"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [aws_db_instance.rates.master_user_secret[0].secret_arn]
    }]
  })
}

# --- EKS: the stateless API (Deployment + HPA live in deploy/k8s) ------------
module "eks" {
  source = "terraform-aws-modules/eks/aws"

  cluster_name    = "rate-atlas-${var.environment}"
  cluster_version = "1.30"
  vpc_id          = module.vpc.vpc_id
  subnet_ids      = module.vpc.private_subnets

  eks_managed_node_groups = {
    api = {
      instance_types = ["t3.medium"]
      min_size       = 2
      max_size       = 8
      desired_size   = 2
    }
  }
}

# --- RDS: the canonical rate store (SQLite stand-in → managed Postgres) ------
resource "aws_db_subnet_group" "rates" {
  name       = "rate-atlas-${var.environment}"
  subnet_ids = module.vpc.private_subnets
}

resource "aws_db_instance" "rates" {
  identifier                  = "rate-atlas-${var.environment}"
  engine                      = "postgres"
  engine_version              = "16"
  instance_class              = "db.t3.medium"
  allocated_storage           = 20
  max_allocated_storage       = 200 # storage autoscaling
  db_subnet_group_name        = aws_db_subnet_group.rates.name
  multi_az                    = var.environment == "prod"
  storage_encrypted           = true
  manage_master_user_password = true # password lives in Secrets Manager, not state
  backup_retention_period     = 7
  deletion_protection         = var.environment == "prod"
  skip_final_snapshot         = var.environment != "prod"
}

output "cluster_name" { value = module.eks.cluster_name }
output "db_endpoint" { value = aws_db_instance.rates.endpoint }
