/** Explicit compute intent, dynamic eligibility, and observed assignment verification. */
import { SpikeError } from "../platform/security.ts";

export interface ComputeChoice { kind: "CPU" | "GPU"; accelerator: string }
export interface ObservedCompute extends ComputeChoice { variant: "DEFAULT" | "GPU" }
export const CPU_COMPUTE: ComputeChoice = { kind: "CPU", accelerator: "CPU" };

export function gpuIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z][A-Z0-9_-]{0,31}$/.test(value) &&
    !["CPU", "AUTO", "NONE", "TPU"].includes(value) &&
    !/^TPU[_-]|^V[0-9]+[EP][0-9]+$/.test(value);
}

/** AUTO selects once before allocation; a refused allocation never selects again. */
export function selectCompute(requested: string, eligible: unknown): ComputeChoice {
  if (requested === "CPU") return { ...CPU_COMPUTE };
  if (!Array.isArray(eligible) || eligible.length > 64 || eligible.some((value) => !gpuIdentifier(value))) {
    throw new SpikeError("gpu_eligibility_unavailable", "compute", 409);
  }
  const available = [...new Set(eligible as string[])].sort();
  const preferred = ["L4", "T4", "A100", "G4"].find((value) => available.includes(value)) ?? available[0];
  const accelerator = requested === "AUTO" ? preferred : requested;
  if (!accelerator || !gpuIdentifier(accelerator) || !available.includes(accelerator)) {
    throw new SpikeError("gpu_not_eligible", "compute", 409);
  }
  return { kind: "GPU", accelerator };
}

/** Listed assignments are the source of truth, not the requested machine string. */
export function observedCompute(assignment: Record<string, unknown>, selected: ComputeChoice): ObservedCompute {
  let observed: ObservedCompute;
  if ((assignment.variant === 0 || assignment.variant === "DEFAULT") && assignment.accelerator === "NONE") {
    observed = { kind: "CPU", accelerator: "CPU", variant: "DEFAULT" };
  } else if ((assignment.variant === 1 || assignment.variant === "GPU") && gpuIdentifier(assignment.accelerator)) {
    observed = { kind: "GPU", accelerator: assignment.accelerator, variant: "GPU" };
  } else throw new SpikeError("assignment_compute_unverified", "open");
  if (observed.kind !== selected.kind || observed.accelerator !== selected.accelerator) {
    throw new SpikeError("assignment_compute_mismatch", "open");
  }
  return observed;
}
