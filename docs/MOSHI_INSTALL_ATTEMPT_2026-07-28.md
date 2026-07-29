# Kyutai Moshi on this machine — install attempt and verdict

**Date:** 2026-07-28
**Session:** f3673e34/agent-M3-moshi-silent
**Question asked:** can Kyutai Moshi run on Troy's hardware?

**Short answer:** the PyTorch backend is **hard-blocked** — measured CUDA OOM,
error pasted below. The Rust/Candle int8 backend is **not blocked at
allocation** the way I expected, but it overshoots physical VRAM by 1.6–2.0 GiB
and can only run by spilling into system RAM across PCIe. Real-time full-duplex
on that path is very unlikely, **and I did not measure it** — see §6 for exactly
where the evidence stops.

Every number below is measured on this machine or read from a primary source
(the HuggingFace file API, or Kyutai's own README).

---

## 0. Two things I got wrong, corrected by measurement

I am recording these because the briefing I worked from asserted both, and the
hardware contradicted both. Neither changes the final recommendation, but a
wrong reason is still wrong.

| Claim I started with | What the GPU actually reported |
|---|---|
| "Turing TU116 has no tensor cores, so **bf16 is unsupported in hardware**" | `torch.cuda.is_bf16_supported()` → **True**, and a bf16 matmul executed and returned a correct checksum (262144.0). bf16 is *not* the blocker. |
| "7.61 GiB of int8 weights **cannot be allocated** on a 6.00 GiB card" | The 8,169,420,704-byte allocation **succeeded**. Windows WDDM lets the driver spill past physical VRAM into system RAM. Only the 14.32 GiB bf16 allocation hard-failed. |

The real blocker is **memory bandwidth and PCIe spill**, not dtype support and
not a refusal to allocate.

---

## 1. Measured hardware

```
nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free,driver_version,compute_cap --format=csv
NVIDIA GeForce GTX 1660 Ti, 6144 MiB, 3248 MiB, 2719 MiB, 566.36, 7.5
```

From PyTorch on the device itself:

```
device               : NVIDIA GeForce GTX 1660 Ti
compute capability   : (7, 5)
total VRAM (bytes)   : 6442123264
total VRAM (GiB)     : 6.00
bf16_supported       : True
```

15.9 GB system RAM.

## 2. Model sizes — HuggingFace file API, not estimates

`kyutai/moshiko-candle-q8` (the int8 Rust/Candle checkpoint):

| File | Bytes |
|---|---|
| `model.q8.gguf` | 8,169,420,704 (**7.61 GiB**) |
| `tokenizer-e351c8d8-checkpoint125.safetensors` (Mimi) | 384,644,900 (0.36 GiB) |
| `tokenizer_spm_32k_3.model` | 552,778 |
| **repo total** | **8,554,618,382** |

`kyutai/moshiko-pytorch-bf16`:

| File | Bytes |
|---|---|
| `model.safetensors` | 15,375,500,136 (**14.32 GiB**) |
| `tokenizer-e351c8d8-checkpoint125.safetensors` (Mimi) | 384,644,900 |
| **repo total** | **15,760,697,814** |

int8 is the floor for CUDA. int4 exists only in the MLX (Apple Silicon) line,
which does not apply to this machine.

## 3. Kyutai's own README, quoted verbatim

Fetched from `raw.githubusercontent.com/kyutai-labs/moshi/main/README.md`:

> "At the moment, we do not support quantization for the PyTorch version, so
> you will need a GPU with a significant amount of memory (24GB)."

> "You will need at least Python 3.10, with 3.12 recommended."

Quantization by backend, per the same README: **PyTorch** — none. **MLX** —
int4, int8, bf16 (Apple Silicon). **Rust/Candle** — int8, bf16.

## 4. The install — it works; the model is the problem

```
uv venv --python 3.12 E:\Helmion\artifacts\moshi-venv
  Downloading cpython-3.12.13-windows-x86_64-none (download) (20.9MiB)
  Using CPython 3.12.13
  venv exit=0

uv pip install -U moshi
  Resolved 37 packages in 1.07s
  Prepared 37 packages in 1m 01s
  + torch==2.9.1
  install exit=0
```

Probe of that environment:

```
moshi      0.2.13
torch      2.9.1+cpu
torch cuda build: None
cuda_available  : False
```

**Finding worth flagging on its own:** Kyutai's documented install command
(`pip install -U moshi`) resolves to **`torch 2.9.1+cpu`** on Windows — a
CPU-only wheel, 105.8 MiB, with `torch.cuda.is_available()` **False**.
Following the README exactly on Windows produces a Moshi that never touches the
GPU. A CUDA build requires explicitly adding
`--index-url https://download.pytorch.org/whl/cu126`, which pulls 2.4 GiB and
resolves to `torch 2.13.0+cu126`.

## 5. The allocation test — real output

Script: `E:\Helmion\artifacts\moshi-gpu-probe.py`. Allocates each published
checkpoint's exact byte count on `cuda:0`.

```
--- attempting to allocate int8 / candle-q8: 8,169,420,704 bytes (7.61 GiB) on cuda:0 ---
   ALLOCATED OK

--- attempting to allocate bf16 / pytorch: 15,375,500,136 bytes (14.32 GiB) on cuda:0 ---
   FAILED: CUDA out of memory. Tried to allocate 14.32 GiB. GPU 0 has a total
   capacity of 6.00 GiB of which 5.01 GiB is free. Of the allocated memory 0 bytes
   is allocated by PyTorch, and 0 bytes is reserved by PyTorch but unallocated.

--- bf16 tensor op on this device ---
   bf16 matmul ran, checksum: 262144.0
```

with the driver-level warning:

```
[W728 19:39:19] CUDACachingAllocator.cpp:3933] memory allocation failed with OOM
on device 0 while trying to allocate 15376318464 bytes
(free: 5379194880, total: 6442123264).
```

**Reading of this result.** A 7.61 GiB allocation succeeding on a card whose
own driver reports 6.00 GiB total and 5.01 GiB free is only possible via
Windows WDDM system-memory fallback — the driver backs the excess with host RAM
over PCIe. So the int8 model would *load*, with roughly **1.6 GiB of weights
(2.0 GiB including Mimi) permanently resident in system RAM**, re-fetched
across PCIe on every forward pass.

## 6. Where my evidence stops — read this before quoting the verdict

**I did not run Moshi.** I did not download the 8.55 GiB checkpoint, did not
install rustup or the CUDA toolkit, and did not build `moshi-backend`. So I have
**no measured token rate and no measured latency** for the int8 path.

What I can say with arithmetic rather than measurement: Moshi's full-duplex loop
runs at a 12.5 Hz frame rate. The GTX 1660 Ti has ~288 GB/s of VRAM bandwidth;
PCIe 3.0 x16 delivers ~12 GB/s in practice. Streaming ~2 GiB of spilled weights
across PCIe once per frame costs on the order of 165 ms, against an 80 ms frame
budget. That points to roughly half the required real-time rate before any
compute is counted — which is why I am calling real-time duplex "very unlikely"
rather than "impossible". **That sentence is reasoning, not a measurement, and
should not be quoted as one.**

The PyTorch verdict, by contrast, *is* measured: pasted OOM above.

## 7. Toolchain state (what finishing the Rust path would cost)

| Prerequisite | State on this machine |
|---|---|
| `cargo` / `rustc` | **NOT FOUND** |
| `nvcc` (CUDA toolkit) | **NOT FOUND**, `CUDA_PATH` unset |
| MSVC C++ toolset | present — 14.29.30133 (VS 2019 Community) |
| VS 2026 Community | installed but has **no** `VC\Tools\MSVC` |
| Python | 3.14 (default), 3.11, and uv-managed **3.12.13** |
| Disk free | C: 30.0 GB, E: 87.5 GB |

Finishing it means rustup (~1.5 GB) + CUDA Toolkit (~3 GB download, admin,
system-wide) + 8.55 GB of weights ≈ **16 GB and several hours**. That is a
reasonable next session if Troy wants the token-rate number measured rather than
reasoned. It is not worth doing tonight to confirm a result that only gets more
pessimistic from here.

## 8. What hardware WOULD run it

| Path | Minimum realistic GPU |
|---|---|
| Rust/Candle **int8** | ~10–12 GB VRAM so nothing spills — RTX 3060 12 GB, RTX 4070 / 4070 Ti, RTX 3080 12 GB |
| PyTorch **bf16** | **24 GB** per Kyutai — RTX 3090, RTX 4090, A5000, L4 24 GB |
| MLX int4 / int8 | Apple Silicon (M-series), ≥16 GB unified memory |

The 12 GB tier only clears the weights; Kyutai themselves name 24 GB for a
comfortable PyTorch run.

## 9. Consequence for Helmion

The three-backend switch shipped this session (`VoiceBackendSelector.cs`) treats
"no Moshi on this machine" as its **primary** configuration, not an edge case:
`duplexFactory: null` means Moshi is not installed, the selector reports that
reason verbatim in its status detail, and voice runs on Whisper+Kokoro. Proven
by `VoiceBackendSmokeChecks.CheckFallsBackWhenNoMoshiInstalled()`.

**No Moshi adapter, stub, mock, or fake client was written.** There is no
`MoshiDuplexSession.cs` in the tree. A duplex implementation that silently fell
back would be a lie about which brain answered; the honest shape is a null
factory plus a status pill that says why.

If Troy later puts a 12 GB+ card in the machine, the remaining work is one class
implementing `IDuplexVoiceSession` (interface defined and already exercised by
the suite) and passing a non-null `duplexFactory`. The selector, probe,
fallback, and status contract are built and tested around that seam today.

## 10. Cleanup

`E:\Helmion\artifacts\moshi-venv` (~5 GB with the CUDA torch build) and the uv
cache are left in place so a follow-up session can resume without re-downloading.
Both are disposable — deleting `moshi-venv` and running
`uv cache clean` reclaims the space with no effect on Helmion.
