# 批量邮箱复用已接入的子域

子域名称支持随机生成或管理员自定义，批量创建邮箱时复用所选的已接入子域，不为每个地址配置新子域。Cloudflare 当前按 zone 限制邮件服务的域名配置数量，因此用不同邮箱前缀实现网站地址的独立管理，将有限的子域配置与邮箱数量分开。代价是多个网站地址可能共享同一子域；首版由管理员预先完成 Cloudflare 配置并验证收信。

依据：[Cloudflare 子域配置说明](https://developers.cloudflare.com/email-service/configuration/subdomains/)（2026-09-14 核对）。
