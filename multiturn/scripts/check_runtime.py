"""断网运行前检查：架构、版本、资源和真实挂载权限，不读取真实凭据。"""
import argparse
import json
import os
from pathlib import Path
import platform
import stat
import subprocess
import sys
import uuid

PROBE_CONTENT = b'bfcl-public-permission-probe'
ARCHITECTURES = {'linux/arm64': ('arm64', {'arm64', 'aarch64'}),
                 'linux/amd64': ('x64', {'amd64', 'x86_64'})}


def verify_runtime_identity(config, identity):
    runtime = config.get('runtime') if isinstance(config, dict) else None
    if not isinstance(runtime, dict) or runtime.get('platform') not in ARCHITECTURES:
        raise ValueError('运行配置缺少支持的平台')
    if not isinstance(identity, dict) or identity.get('platform') != runtime['platform']:
        raise ValueError('实际运行平台与配置不一致')
    node_arch, python_arches = ARCHITECTURES[runtime['platform']]
    if (identity.get('nodeArchitecture') != node_arch
            or str(identity.get('pythonArchitecture', '')).lower() not in python_arches):
        raise ValueError('Node 与 Python 架构必须同时匹配目标平台')
    for key in ['nodeVersion', 'pythonVersion']:
        if not isinstance(runtime.get(key), str) or not runtime[key] or identity.get(key) != runtime[key]:
            raise ValueError('运行版本与固定配置不一致：' + key)


def check_resources(directory=Path('/sys/fs/cgroup')):
    if not (directory / 'cgroup.controllers').is_file():
        raise ValueError('需要 cgroup v2 容器')
    cpu = (directory / 'cpu.max').read_text().strip()
    memory = (directory / 'memory.max').read_text().strip()
    swap = (directory / 'memory.swap.max').read_text().strip()
    if cpu != '200000 100000' or memory != str(4 * 1024 ** 3) or swap != '0':
        raise ValueError('容器资源必须为 2 CPU / 4 GiB / 无 swap')
    return {'cgroupVersion': 2, 'cpuMax': cpu, 'memoryMax': int(memory), 'swapMax': int(swap)}


def check_permissions(directory, credential_probe):
    if credential_probe.read_bytes() != PROBE_CONTENT:
        raise ValueError('假凭据探针内容不匹配；不输出文件内容')
    name = directory / ('.runtime-probe-' + uuid.uuid4().hex)
    linked, created = name.with_suffix('.link'), []
    try:
        with name.open('xb') as stream:
            created.append(name)
            stream.write(b'create'); stream.flush(); os.fsync(stream.fileno())
        with name.open('ab') as stream:
            stream.write(b'-append'); stream.flush(); os.fsync(stream.fileno())
        os.link(name, linked); created.append(linked)
        if name.read_bytes() != b'create-append' or linked.read_bytes() != b'create-append':
            raise ValueError('目录读写或硬链接内容不一致')
    finally:
        for path in reversed(created):
            path.unlink(missing_ok=True)
    return {'exclusiveCreate': True, 'append': True, 'fsync': True, 'hardlink': True,
            'read': True, 'cleanup': True, 'credentialReadable': True,
            'credentialMode': oct(stat.S_IMODE(credential_probe.stat().st_mode))}


def write_new(path, value):
    with path.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n'); stream.flush(); os.fsync(stream.fileno())


def probe(config, directory, credential_probe, output):
    result = subprocess.run(['node', '-p', 'JSON.stringify({arch:process.arch,version:process.versions.node})'],
                            capture_output=True, text=True, check=True, timeout=15)
    node = json.loads(result.stdout)
    identity = {'platform': config.get('runtime', {}).get('platform'), 'nodeArchitecture': node.get('arch'),
                'pythonArchitecture': platform.machine(), 'nodeVersion': node.get('version'),
                'pythonVersion': sys.version.split()[0]}
    verify_runtime_identity(config, identity)
    resources = check_resources()
    permissions = check_permissions(directory, credential_probe)
    identity_path = directory / 'runtime-identity.json'
    try:
        write_new(identity_path, identity)
    except FileExistsError:
        if json.loads(identity_path.read_text(encoding='utf-8')) != identity:
            raise ValueError('原运行身份不同，不能覆盖或混合续跑')
    report = {'verified': True, 'identity': identity, 'uid': getattr(os, 'getuid', lambda: None)(),
              'gid': getattr(os, 'getgid', lambda: None)(), 'resources': resources,
              'permissions': permissions, 'realModelCalls': 0}
    write_new(output, report)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ['config', 'directory', 'credential-probe', 'output']:
        parser.add_argument('--' + option, required=True, type=Path)
    args = parser.parse_args()
    report = probe(json.loads(args.config.read_text(encoding='utf-8')), args.directory, args.credential_probe, args.output)
    print(json.dumps(report, ensure_ascii=False))
