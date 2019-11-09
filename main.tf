provider "google" {
  project = "verbum-356716"
  region = "us-central1"
  zone = "us-central1-c"
}

data "google_container_cluster" "verbum_cluster" {
  name = "verbum_cluster"
  location = "us-central1-c"
  project = "verbum-356716"
}

output "cluster_username" {
  value = "${data.google_container_cluster.verbum_cluster.master_auth.0.username}"
}

output "cluster_password" {
  value = "${data.google_container_cluster.verbum_cluster.master_auth.0.password}"
}

output "endpoint" {
  value = "${data.google_container_cluster.verbum_cluster.endpoint}"
}

output "instance_group_urls" {
  value = "${data.google_container_cluster.verbum_cluster.instance_group_urls}"
}

output "node_config" {
  value = "${data.google_container_cluster.verbum_cluster.node_config}"
}

output "node_pools" {
  value = "${data.google_container_cluster.verbum_cluster.node_pool}"
}