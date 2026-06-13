###############################################################################
# baseplate — platform foundation (ILLUSTRATIVE, "what the platform provides").
#
# The shared substrate every service on the paved road rides on: remote state
# (S3 + DynamoDB lock), a VPC, an EKS cluster, and the reusable `service` module
# (see modules/service) that each workload invokes for its ECR/IRSA/namespace/
# RDS. NOT applied anywhere — the live demo runs on Render's free tier. The
# shape is the point; upstream module bodies aren't vendored, so
# `terraform validate` is not expected to pass standalone.
###############################################################################

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  # Remote state — S3 bucket + DynamoDB lock table, per-environment key.
  backend "s3" {
    bucket         = "ORG-platform-tfstate"
    key            = "baseplate/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "terraform-locks"
    encrypt        = true
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      platform = "baseplate"
      owner    = "platform-engineering"
      managed  = "terraform"
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

# --- Network: one shared VPC for the cluster ---------------------------------
module "vpc" {
  source = "terraform-aws-modules/vpc/aws"

  name            = "baseplate-${var.environment}"
  cidr            = "10.60.0.0/16"
  azs             = ["${var.region}a", "${var.region}b", "${var.region}c"]
  private_subnets = ["10.60.1.0/24", "10.60.2.0/24", "10.60.3.0/24"]
  public_subnets  = ["10.60.101.0/24", "10.60.102.0/24", "10.60.103.0/24"]

  enable_nat_gateway = true
  single_nat_gateway = var.environment != "prod" # one NAT in non-prod to save cost
}

# --- EKS: the cluster every workload deploys into (GitOps via Argo CD) -------
module "eks" {
  source = "terraform-aws-modules/eks/aws"

  cluster_name    = "baseplate-${var.environment}"
  cluster_version = "1.30"
  vpc_id          = module.vpc.vpc_id
  subnet_ids      = module.vpc.private_subnets

  eks_managed_node_groups = {
    general = {
      instance_types = ["t3.large"]
      min_size       = 2
      max_size       = 10
      desired_size   = 3
    }
  }
}

# --- Services on the paved road: each is one `service` module block ----------
# New services are onboarded by adding a block like this (the scaffolder
# generates it). The module gives them ECR + IRSA + namespace [+ RDS].
module "rate_ingest" {
  source       = "./modules/service"
  name         = "rate-ingest"
  environment  = var.environment
  exposes_http = true
  needs_db     = true

  oidc_provider_arn = module.eks.oidc_provider_arn
  vpc_id            = module.vpc.vpc_id
  private_subnets   = module.vpc.private_subnets
}

output "cluster_name" { value = module.eks.cluster_name }
output "rate_ingest_ecr_url" { value = module.rate_ingest.ecr_repository_url }
