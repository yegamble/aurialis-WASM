//go:build (!darwin || !cgo) && amd64 && !noasm && !safe && !gccgo

#include "textflag.h"

// cspell:words AVX2 FMA VMOVUPS VBROADCASTSS VFMADD231PS VZEROUPPER
// Four independent rows and sixteen output columns. B is contiguous and
// reused across all rows; eight accumulators hide FMA dependency latency.
TEXT ·packedKernel4x16(SB), NOSPLIT, $0-48
 MOVQ dst+0(FP), DI
 MOVQ left+8(FP), SI
 MOVQ panel+16(FP), DX
 MOVQ leftStride+24(FP), R8
 MOVQ dstStride+32(FP), R9
 MOVQ depth+40(FP), CX
 LEAQ (SI)(R8*1), R10
 LEAQ (R10)(R8*1), R11
 LEAQ (R11)(R8*1), R12
 LEAQ (DI)(R9*1), R13
 LEAQ (R13)(R9*1), R14
 LEAQ (R14)(R9*1), R15
 VMOVUPS (DI), Y0
 VMOVUPS 32(DI), Y1
 VMOVUPS (R13), Y2
 VMOVUPS 32(R13), Y3
 VMOVUPS (R14), Y4
 VMOVUPS 32(R14), Y5
 VMOVUPS (R15), Y6
 VMOVUPS 32(R15), Y7
loop:
 VMOVUPS (DX), Y8
 VMOVUPS 32(DX), Y9
 VBROADCASTSS (SI), Y10
 VBROADCASTSS (R10), Y11
 VBROADCASTSS (R11), Y12
 VBROADCASTSS (R12), Y13
 VFMADD231PS Y8, Y10, Y0
 VFMADD231PS Y9, Y10, Y1
 VFMADD231PS Y8, Y11, Y2
 VFMADD231PS Y9, Y11, Y3
 VFMADD231PS Y8, Y12, Y4
 VFMADD231PS Y9, Y12, Y5
 VFMADD231PS Y8, Y13, Y6
 VFMADD231PS Y9, Y13, Y7
 ADDQ $4, SI
 ADDQ $4, R10
 ADDQ $4, R11
 ADDQ $4, R12
 ADDQ $64, DX
 DECQ CX
 JNZ loop
 VMOVUPS Y0, (DI)
 VMOVUPS Y1, 32(DI)
 VMOVUPS Y2, (R13)
 VMOVUPS Y3, 32(R13)
 VMOVUPS Y4, (R14)
 VMOVUPS Y5, 32(R14)
 VMOVUPS Y6, (R15)
 VMOVUPS Y7, 32(R15)
 VZEROUPPER
 RET

// One-row edge of the four-row kernel. Both accumulate each dot product
// in increasing inner-index order with one FMA per term and no reduction.
TEXT ·packedKernel1x16(SB), NOSPLIT, $0-32
 MOVQ dst+0(FP), DI
 MOVQ left+8(FP), SI
 MOVQ panel+16(FP), DX
 MOVQ depth+24(FP), CX
 VMOVUPS (DI), Y0
 VMOVUPS 32(DI), Y1
rowLoop:
 VMOVUPS (DX), Y2
 VMOVUPS 32(DX), Y3
 VBROADCASTSS (SI), Y4
 VFMADD231PS Y2, Y4, Y0
 VFMADD231PS Y3, Y4, Y1
 ADDQ $4, SI
 ADDQ $64, DX
 DECQ CX
 JNZ rowLoop
 VMOVUPS Y0, (DI)
 VMOVUPS Y1, 32(DI)
 VZEROUPPER
 RET
