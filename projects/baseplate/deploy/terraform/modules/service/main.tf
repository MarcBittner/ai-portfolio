###############################################################################
# baseplate — reusable `service` module (ILLUSTRATIVE, "what the platform
# provides"). Onboarding a new service to the paved road is one `module` block:
# it gets an ECR repo, a scoped IRSA role (keyless pod identity — no long-lived
# AWS keys), a Kubernetes namespace, and (when needs_db) an RDS Postgres whose
# connection string lives in Secrets Manager, never in state.
#
# NOT applied anywhere: the live demo runs on Render's free tier. The shape is
# the point; module bodies of the referenced upstream modules are not vendored,
# so `terraform validate` is not expected to pass standalone.
###############################################################################

variable "name" { type = string }
variable "environment" {
  type    = string
  default = "prod"
}
variable "exposes_http" {
  type    = bool
  default = true
}
variable "needs_db" {
  type    = bool
  default = false
}
variable "oidc_provider_arn" { type = string }
variable "vpc_id" { type = string }
variable "private_subnets" { type = list(string) }

locals {
  full_name = "${var.name}-${var.environment}"
  tags = {
    service     = var.name
    environment = var.environment
    managed     = "terraform"
    paved_road  = "baseplate"
  }
}

# --- ECR: one repo per service, scanned on push, immutable tags ---------------
resource "aws_ecr_repository" "this" {
  name                 = var.name
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  tags = local.tags
}

# --- IRSA: a scoped role the service account assumes (keyless) ----------------
module "irsa" {
  source = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"

  role_name = local.full_name
  oidc_providers = {
    main = {
      provider_arn               = var.oidc_provider_arn
      namespace_service_accounts = ["${var.name}:${var.name}"]
    }
  }
  # Only services that need a DB get the secret-read policy attached.
  role_policy_arns = var.needs_db ? { db = aws_iam_policy.read_db_secret[0].arn } : {}
}

# --- RDS Postgres: provisioned only when the service declares needs_db --------
resource "aws_db_subnet_group" "this" {
  count      = var.needs_db ? 1 : 0
  name       = local.full_name
  subnet_ids = var.private_subnets
  tags       = local.tags
}

resource "aws_db_instance" "this" {
  count                       = var.needs_db ? 1 : 0
  identifier                  = local.full_name
  engine                      = "postgres"
  engine_version              = "16"
  instance_class              = "db.t3.medium"
  allocated_storage           = 20
  max_allocated_storage       = 200
  db_subnet_group_name        = aws_db_subnet_group.this[0].name
  multi_az                    = var.environment == "prod"
  storage_encrypted           = true
  manage_master_user_password = true # password in Secrets Manager, not in state
  backup_retention_period     = 7
  deletion_protection         = var.environment == "prod"
  skip_final_snapshot         = var.environment != "prod"
  tags                        = local.tags
}

resource "aws_iam_policy" "read_db_secret" {
  count = var.needs_db ? 1 : 0
  name  = "${local.full_name}-read-db-secret"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [aws_db_instance.this[0].master_user_secret[0].secret_arn]
    }]
  })
}

output "ecr_repository_url" { value = aws_ecr_repository.this.repository_url }
output "irsa_role_arn" { value = module.irsa.iam_role_arn }
output "db_endpoint" {
  value = var.needs_db ? aws_db_instance.this[0].endpoint : null
}
