# infra/

环境探测、Docker Compose、Prometheus/Grafana 配置。

> Phase 0 只放探测脚本说明。Docker/Prometheus 配置 Phase 2/3 补充。

## 机器规格探测

复现 AGENTS.md 中机器规格的命令:

### Linux(jd)

```bash
ssh jd '
  echo "[HOSTNAME] $(hostname)";
  echo "[KERNEL]   $(uname -srm)";
  echo "[CPU]      $(grep -m1 "model name" /proc/cpuinfo | cut -d: -f2 | xargs)";
  echo "[CORES]    $(nproc) logical";
  lscpu | grep -E "^Socket|^Core|^Thread";
  echo "[MEM]      $(free -h | awk /^Mem:/{print \$2})";
  echo "[DISK]     $(df -h / | awk NR==2{print \$2\" / free \"\$4})";
  ip -br link | grep -v "^lo";
  echo "[ULIMIT]   $(ulimit -n)";
  echo "[SOMAXCONN]$(cat /proc/sys/net/core/somaxconn)";
  lsb_release -a 2>/dev/null || grep ^PRETTY /etc/os-release
'
```

### macOS(xyz-mac)

```bash
ssh xyz-mac '
  echo "[HOSTNAME] $(hostname)";
  echo "[KERNEL]   $(uname -srm)";
  echo "[CPU]      $(sysctl -n machdep.cpu.brand_string)";
  echo "[CORES_P]  $(sysctl -n hw.physicalcpu)";
  echo "[CORES_L]  $(sysctl -n hw.logicalcpu)";
  echo "[MEM_GB]   $(( $(sysctl -n hw.memsize) / 1073741824 ))";
  echo "[DISK]     $(df -h / | awk NR==2{print \$2\" / free \"\$4})";
  echo "[ULIMIT]   $(ulimit -n)";
  echo "[SOMAXCONN]$(sysctl -n kern.ipc.somaxconn)";
'
```

## 压测前调优(BENCHMARK_SPEC §5.2)

### xyz-mac(macOS)

```bash
# 永久(需 sudo):写入 /etc/sysctl.conf 或 LaunchDaemon
sudo sysctl -w kern.ipc.somaxconn=4096
# ulimit -n:macOS 需通过 launchctl 设置全局上限
sudo launchctl limit maxfiles 65535 65535
ulimit -n 65535  # 当前 shell
```

> macOS 调 ulimit 较繁琐,完整步骤见 Phase 1 实施时文档。

### jd(Linux)

```bash
echo "* soft nofile 65535" | sudo tee -a /etc/security/limits.conf
echo "* hard nofile 65535" | sudo tee -a /etc/security/limits.conf
# 当前 session
ulimit -n 65535
```
