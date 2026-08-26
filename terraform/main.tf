terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.100"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
  }
}

provider "azurerm" {
  features {}
}

variable "github_repo_url" {
  description = "HTTPS URL of the ScaleLink GitHub repo to clone on each app VM"
  type        = string
}

variable "location" {
  description = "Azure region"
  type        = string
  default     = "centralindia" # closest region for lower latency from India; change freely
}

variable "vm_size" {
  description = "VM size for both app and redis VMs. B1s is the smallest/cheapest burstable size."
  type        = string
  default     = "Standard_B1s"
}

variable "admin_username" {
  type    = string
  default = "azureuser"
}

variable "rate_limit_max_requests" {
  description = "Requests allowed per client IP per rate_limit_window_seconds"
  type        = number
  default     = 20
}

variable "rate_limit_window_seconds" {
  type    = number
  default = 10
}

# --- Resource Group ---
resource "azurerm_resource_group" "main" {
  name     = "scalelink-rg"
  location = var.location
}

# --- Networking ---
resource "azurerm_virtual_network" "main" {
  name                = "scalelink-vnet"
  address_space       = ["10.10.0.0/16"]
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
}

resource "azurerm_subnet" "main" {
  name                 = "scalelink-subnet"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.10.1.0/24"]
}

# Standard-SKU Load Balancer backend VMs get NO outbound internet access by
# default when they have no public IP of their own (unlike Basic LB, which
# allows default outbound). A NAT Gateway on the subnet gives every VM -
# app and redis alike - outbound-only internet for apt/git/docker pulls
# during cloud-init, without exposing any of them via inbound public IPs.
resource "azurerm_public_ip" "natgw" {
  name                = "scalelink-natgw-pip"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  allocation_method   = "Static"
  sku                 = "Standard"
}

resource "azurerm_nat_gateway" "main" {
  name                = "scalelink-natgw"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku_name            = "Standard"
}

resource "azurerm_nat_gateway_public_ip_association" "main" {
  nat_gateway_id       = azurerm_nat_gateway.main.id
  public_ip_address_id = azurerm_public_ip.natgw.id
}

resource "azurerm_subnet_nat_gateway_association" "main" {
  subnet_id      = azurerm_subnet.main.id
  nat_gateway_id = azurerm_nat_gateway.main.id
}

resource "azurerm_network_security_group" "app" {
  name                = "scalelink-app-nsg"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name

  security_rule {
    name                       = "AllowHTTP"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "8080"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "AllowSSH"
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefix      = "*" # tighten to your IP if you want, e.g. "203.0.113.4/32"
    destination_address_prefix = "*"
  }
}

resource "azurerm_network_security_group" "redis" {
  name                = "scalelink-redis-nsg"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name

  security_rule {
    name                       = "AllowRedisFromVNet"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "6379"
    source_address_prefix      = "10.10.1.0/24" # only the app subnet, never the internet
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "AllowSSH"
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }
}

# --- SSH key (generated locally by Terraform so you don't need to create one by hand) ---
resource "tls_private_key" "ssh" {
  algorithm = "RSA"
  rsa_bits  = 4096
}

resource "local_file" "ssh_private_key" {
  content         = tls_private_key.ssh.private_key_pem
  filename        = "${path.module}/scalelink_ssh_key.pem"
  file_permission = "0600"
}

# --- Redis VM (private only, no public IP) ---
resource "azurerm_network_interface" "redis" {
  name                = "scalelink-redis-nic"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name

  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.main.id
    private_ip_address_allocation = "Static"
    private_ip_address            = "10.10.1.10"
  }
}

resource "azurerm_network_interface_security_group_association" "redis" {
  network_interface_id     = azurerm_network_interface.redis.id
  network_security_group_id = azurerm_network_security_group.redis.id
}

resource "azurerm_linux_virtual_machine" "redis" {
  name                = "scalelink-redis-vm"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  size                = var.vm_size
  admin_username      = var.admin_username
  network_interface_ids = [azurerm_network_interface.redis.id]

  admin_ssh_key {
    username   = var.admin_username
    public_key = tls_private_key.ssh.public_key_openssh
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Standard_LRS"
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-jammy"
    sku       = "22_04-lts-gen2"
    version   = "latest"
  }

  custom_data = base64encode(templatefile("${path.module}/redis-cloud-init.sh.tpl", {}))

  depends_on = [azurerm_subnet_nat_gateway_association.main]
}

# --- App VMs (x2), each running the ScaleLink container ---
resource "azurerm_public_ip" "lb" {
  name                = "scalelink-lb-pip"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  allocation_method   = "Static"
  sku                 = "Standard"
}

resource "azurerm_lb" "main" {
  name                = "scalelink-lb"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "Standard"

  frontend_ip_configuration {
    name                 = "frontend"
    public_ip_address_id = azurerm_public_ip.lb.id
  }
}

resource "azurerm_lb_backend_address_pool" "main" {
  loadbalancer_id = azurerm_lb.main.id
  name            = "app-pool"
}

resource "azurerm_lb_probe" "health" {
  loadbalancer_id = azurerm_lb.main.id
  name            = "health-probe"
  port            = 8080
  request_path    = "/health"
  protocol        = "Http"
}

resource "azurerm_lb_rule" "http" {
  loadbalancer_id                = azurerm_lb.main.id
  name                           = "http-rule"
  protocol                       = "Tcp"
  frontend_port                  = 80
  backend_port                   = 8080
  frontend_ip_configuration_name = "frontend"
  backend_address_pool_ids       = [azurerm_lb_backend_address_pool.main.id]
  probe_id                       = azurerm_lb_probe.health.id
}

resource "azurerm_network_interface" "app" {
  count               = 2
  name                = "scalelink-app-nic-${count.index}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name

  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.main.id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_network_interface_security_group_association" "app" {
  count                      = 2
  network_interface_id      = azurerm_network_interface.app[count.index].id
  network_security_group_id = azurerm_network_security_group.app.id
}

resource "azurerm_network_interface_backend_address_pool_association" "app" {
  count                   = 2
  network_interface_id   = azurerm_network_interface.app[count.index].id
  ip_configuration_name  = "internal"
  backend_address_pool_id = azurerm_lb_backend_address_pool.main.id
}

resource "azurerm_linux_virtual_machine" "app" {
  count               = 2
  name                = "scalelink-app-vm-${count.index}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  size                = var.vm_size
  admin_username      = var.admin_username
  network_interface_ids = [azurerm_network_interface.app[count.index].id]

  admin_ssh_key {
    username   = var.admin_username
    public_key = tls_private_key.ssh.public_key_openssh
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Standard_LRS"
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-jammy"
    sku       = "22_04-lts-gen2"
    version   = "latest"
  }

  custom_data = base64encode(templatefile("${path.module}/app-cloud-init.sh.tpl", {
    github_repo_url          = var.github_repo_url
    redis_private_ip         = azurerm_network_interface.redis.private_ip_address
    instance_id              = "app-${count.index}"
    lb_public_ip             = azurerm_public_ip.lb.ip_address
    rate_limit_max_requests  = var.rate_limit_max_requests
    rate_limit_window_seconds = var.rate_limit_window_seconds
  }))

  depends_on = [azurerm_linux_virtual_machine.redis, azurerm_subnet_nat_gateway_association.main]
}

output "load_balancer_public_ip" {
  value       = azurerm_public_ip.lb.ip_address
  description = "Hit this IP on port 80 to reach the app through the load balancer"
}

output "app_vm_names" {
  value = azurerm_linux_virtual_machine.app[*].name
}

output "redis_private_ip" {
  value = azurerm_network_interface.redis.private_ip_address
}

output "ssh_private_key_path" {
  value = local_file.ssh_private_key.filename
}
