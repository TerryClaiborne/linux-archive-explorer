# Security Policy

Linux Archive Explorer provides administrative access to Linux files and should only be installed on systems you own or are authorized to manage.

Use strong passwords and HTTPS when accessing the application over the Internet.

## Reporting Security Issues

If you discover a security vulnerability, please report it privately through GitHub's security reporting feature, if available.

Do not publicly disclose vulnerabilities or include passwords, credentials, or other sensitive information in issue reports.

## Disclaimer

Users are responsible for securing their own systems, maintaining backups, and controlling access to the application.

Copyright (c) 2026 Terry Claiborne (KC3KMV). All Rights Reserved.

## Local HTTPS and Windows folder access

Chrome's full File System Access directory picker is available only in a secure browser context. Linux Archive Explorer does not provision certificates, create a private CA, or take over TCP port 443. Configure trusted HTTPS separately when a secure browser context is required. Linux Archive Explorer does not alter Tailscale configuration. Public/Internet deployment requires deliberately managed trusted HTTPS or an explicitly trusted HTTPS reverse proxy plus normal network hardening.
