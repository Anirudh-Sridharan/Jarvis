/**
 * RAM headroom probe (feature 1).
 *
 * On Apple Silicon the GPU and CPU share UNIFIED memory, so model weights draw
 * from the same pool as everything else. A precise headroom number would query
 * the Metal/Accelerate allocator (and account for STT/TTS + embedding residency).
 * For Phase 1 we use os.freemem() as a stand-in.
 *
 * TODO(phase2: feature 1) replace with a unified-memory-aware probe that also
 * subtracts the resident embedding model + STT/TTS budgets.
 */
import { freemem, totalmem } from "node:os";

export interface RamProbe {
  headroomGB(): number;
  totalGB(): number;
}

const BYTES_PER_GB = 1024 ** 3;

export class OsRamProbe implements RamProbe {
  headroomGB(): number {
    return freemem() / BYTES_PER_GB;
  }

  totalGB(): number {
    return totalmem() / BYTES_PER_GB;
  }
}
