import { execFile } from 'node:child_process';

function runCommand(file, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, error: error.message, stderr: String(stderr || '').trim() });
        return;
      }
      resolve({ ok: true, stdout: String(stdout || '').trim() });
    });
  });
}

export async function getGpuTelemetry(config) {
  if (!config.enableNvidiaSmi) {
    return { enabled: false, gpus: [], error: null };
  }
  const args = [
    '--query-gpu=index,name,utilization.gpu,memory.total,memory.used,temperature.gpu,power.draw',
    '--format=csv,noheader,nounits'
  ];
  const result = await runCommand(config.nvidiaSmiBin, args, config.gpuTelemetryTimeoutMs);
  if (!result.ok) {
    return { enabled: true, gpus: [], error: result.error || result.stderr || 'nvidia-smi failed' };
  }
  const gpus = result.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [index, name, utilizationGpu, memoryTotal, memoryUsed, temperatureGpu, powerDraw] = line.split(',').map((item) => item.trim());
    return {
      index: Number.parseInt(index, 10),
      name,
      utilizationGpuPct: Number.parseFloat(utilizationGpu),
      memoryTotalMiB: Number.parseFloat(memoryTotal),
      memoryUsedMiB: Number.parseFloat(memoryUsed),
      temperatureC: Number.parseFloat(temperatureGpu),
      powerDrawW: Number.parseFloat(powerDraw)
    };
  });
  return { enabled: true, gpus, error: null };
}
