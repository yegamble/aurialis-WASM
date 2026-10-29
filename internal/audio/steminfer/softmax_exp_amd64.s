//go:build (!darwin || !cgo) && amd64 && !noasm && !safe && !gccgo

// Copyright 2010 The Go Authors. All rights reserved.
// Adapted from Go 1.26.10 src/math/exp_amd64.s. The BSD license is reproduced
// in GO-MATH-LICENSE. The original method and constants are from Naoki
// Shibata, "Efficient evaluation methods of elementary functions suitable
// for SIMD computation", ISC 2010, and his public-domain SLEEF implementation.
// This version evaluates the same float64 FMA polynomial in four lanes.

#include "textflag.h"

DATA expConstants<>+0(SB)/8, $1.4426950408889634073599246810018920
DATA expConstants<>+8(SB)/8, $0.69314718055966295651160180568695068359375
DATA expConstants<>+16(SB)/8, $0.28235290563031577122588448175013436025525412068e-12
DATA expConstants<>+24(SB)/8, $0.0625
DATA expConstants<>+32(SB)/8, $2.4801587301587301587e-5
DATA expConstants<>+40(SB)/8, $1.9841269841269841270e-4
DATA expConstants<>+48(SB)/8, $1.3888888888888888889e-3
DATA expConstants<>+56(SB)/8, $8.3333333333333333333e-3
DATA expConstants<>+64(SB)/8, $4.1666666666666666667e-2
DATA expConstants<>+72(SB)/8, $1.6666666666666666667e-1
DATA expConstants<>+80(SB)/8, $0.5
DATA expConstants<>+88(SB)/8, $1.0
DATA expConstants<>+96(SB)/8, $2.0
DATA expConstants<>+104(SB)/8, $1023
GLOBL expConstants<>(SB), RODATA|NOPTR, $112

TEXT ·expFourLanes(SB), NOSPLIT, $0-16
 MOVQ values+0(FP), SI
 MOVQ count+8(FP), CX
loop:
 VCVTPS2PD (SI), Y0
 VBROADCASTSD expConstants<>+0(SB), Y4
 VMULPD Y4, Y0, Y1
 VCVTPD2DQY Y1, X2
 VCVTDQ2PD X2, Y1
 VPMOVSXDQ X2, Y3
 VPBROADCASTQ expConstants<>+104(SB), Y4
 VPADDQ Y4, Y3, Y3
 VPSLLQ $52, Y3, Y3
 VBROADCASTSD expConstants<>+8(SB), Y4
 VFNMADD231PD Y4, Y1, Y0
 VBROADCASTSD expConstants<>+16(SB), Y4
 VFNMADD231PD Y4, Y1, Y0
 VBROADCASTSD expConstants<>+24(SB), Y4
 VMULPD Y4, Y0, Y0
 VBROADCASTSD expConstants<>+32(SB), Y5
 VBROADCASTSD expConstants<>+40(SB), Y4
 VFMADD213PD Y4, Y0, Y5
 VBROADCASTSD expConstants<>+48(SB), Y4
 VFMADD213PD Y4, Y0, Y5
 VBROADCASTSD expConstants<>+56(SB), Y4
 VFMADD213PD Y4, Y0, Y5
 VBROADCASTSD expConstants<>+64(SB), Y4
 VFMADD213PD Y4, Y0, Y5
 VBROADCASTSD expConstants<>+72(SB), Y4
 VFMADD213PD Y4, Y0, Y5
 VBROADCASTSD expConstants<>+80(SB), Y4
 VFMADD213PD Y4, Y0, Y5
 VBROADCASTSD expConstants<>+88(SB), Y4
 VFMADD213PD Y4, Y0, Y5
 VMULPD Y5, Y0, Y0
 VBROADCASTSD expConstants<>+96(SB), Y4
 VADDPD Y4, Y0, Y6
 VMULPD Y6, Y0, Y0
 VADDPD Y4, Y0, Y6
 VMULPD Y6, Y0, Y0
 VADDPD Y4, Y0, Y6
 VMULPD Y6, Y0, Y0
 VADDPD Y4, Y0, Y6
 VBROADCASTSD expConstants<>+88(SB), Y5
 VFMADD213PD Y5, Y6, Y0
 VMULPD Y3, Y0, Y0
 VCVTPD2PSY Y0, X0
 VMOVUPS X0, (SI)
 ADDQ $16, SI
 SUBQ $4, CX
 JNZ loop
 VZEROUPPER
 RET
