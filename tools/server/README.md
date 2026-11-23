# 给 CreeperUX 代理一份受限的服务器权限

目的：让 Claude 在你的 Navidrome 服务器上做部署相关的事（看状态和日志、备份数据目录、在原版和 CreeperUX 改版镜像之间切换），**此外什么都做不了**。

## 这份权限能做什么、不能做什么

一把专用的 SSH 密钥，在服务器上只能运行 `navidrome-ctl` 这一个脚本里的 7 个操作：

| 操作 | 做什么 |
|---|---|
| `status` | 容器状态、正在用的镜像、现有备份 |
| `logs [行数]` | Navidrome 最近的日志（最多 1000 行） |
| `version` | Navidrome 版本 |
| `check` | 不登录就能问的：服务器声明的扩展；`rest/connect` 是否拒绝没有凭据的请求 |
| `backup` | 停一下 Navidrome，把数据目录（不含缓存）打包到备份目录，再启动；只保留最近 5 份 |
| `use-fork` | 换成 `ghcr.io/creeperux/navidrome:latest`：要求 24 小时内有备份；只写一个它自己的 override 文件，不改你的 compose 文件 |
| `use-upstream` | 删掉那个 override 文件，回到你 compose 文件里原来的镜像 |

做不到的：
- 登录 shell、执行任意命令、读写其他文件、端口转发（`authorized_keys` 里的 `restrict` 和 `command=` 强制只能运行这个脚本；参数只认上表里的词，其余一律拒绝）。
- 碰其他容器、还原备份（还原留给你自己做）。
- 用 docker 做别的事：这个用户**不在 docker 组**，只能通过一条 sudo 规则以 root 运行这一个脚本。
- 登录 Navidrome：脚本里没有任何账号密码，Claude 也不会输入你的密码。
- 密钥过期后（`expiry-time`）或从你指定的地址以外（`from=`），连接直接被拒绝。

每次调用都会记进系统日志：`journalctl -t navidrome-ctl`（或 `grep navidrome-ctl /var/log/syslog`），sudo 自己也会记一条。

## 在服务器上设置（Linux + Docker Compose）

> 如果服务器是群晖、Unraid、TrueNAS 这类 NAS，步骤会不一样，先告诉 Claude。

1. **放脚本**：把 `navidrome-ctl.sh` 复制到服务器，按你的实际情况改开头 5 个变量（compose 文件所在目录、服务名、数据目录、备份目录），然后安装成 root 所有、别人改不了：

   ```sh
   sudo install -o root -g root -m 755 navidrome-ctl.sh /usr/local/bin/navidrome-ctl
   sudo navidrome-ctl status     # 先自己试一次，确认路径都对
   ```

2. **建一个专用用户**（不设密码，只能用密钥登录，不加入 docker 组）：

   ```sh
   sudo useradd --create-home --shell /bin/sh creeperux-agent
   ```

3. **允许它以 root 运行这一个脚本**，别的都不行：

   ```sh
   echo 'creeperux-agent ALL=(root) NOPASSWD: /usr/local/bin/navidrome-ctl *' | sudo tee /etc/sudoers.d/creeperux-agent
   sudo chmod 440 /etc/sudoers.d/creeperux-agent
   sudo visudo -c
   ```

4. **放公钥**：Claude 会给你一行公钥（`ssh-ed25519 AAAA… creeperux-agent`）。下面这行里，`from=` 填这台 Windows 电脑在服务器看来的地址（局域网 IP 或 Tailscale IP，也可以写网段如 `192.168.1.0/24`），`expiry-time=` 是失效日期。文件归 root 所有，那个用户自己改不了：

   ```sh
   sudo install -d -o root -g root -m 755 /home/creeperux-agent/.ssh
   echo 'restrict,command="sudo -n /usr/local/bin/navidrome-ctl \"$SSH_ORIGINAL_COMMAND\"",from="192.168.1.20",expiry-time="20261207" ssh-ed25519 AAAA… creeperux-agent' \
     | sudo tee /home/creeperux-agent/.ssh/authorized_keys
   sudo chmod 644 /home/creeperux-agent/.ssh/authorized_keys
   ```

5. **把服务器的主机指纹发给 Claude**（第一次连接时核对，防止连到冒充的机器）：

   ```sh
   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
   ```

   再告诉它服务器的地址（局域网 IP 或 Tailscale 名）和 SSH 端口。

## Claude 这边

- 在这台电脑上生成一把专用密钥 `~/.ssh/creeperux-agent`（ed25519），只给你看公钥，私钥不离开这台电脑。
- 在 `~/.ssh/config` 里加一个 `creeperux-navidrome` 主机条目，第一次连接时按你给的指纹核对。
- 会改动服务器的两步（`backup`、`use-fork` / `use-upstream`），每次都先在对话里问你。

## 收回权限

任选其一，立即生效：

```sh
sudo rm /home/creeperux-agent/.ssh/authorized_keys      # 只收回这把密钥
sudo userdel -r creeperux-agent && sudo rm /etc/sudoers.d/creeperux-agent   # 整个删掉
```

不做的话，到 `expiry-time` 那天也会自动失效。这台电脑上的私钥可以随时删：`~/.ssh/creeperux-agent`。
