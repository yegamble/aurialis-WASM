//go:build darwin && cgo

package steminfer

// cspell:words softmax steminfer GELU FLT erff vvexpf vvtanhf vDSP maxv vsmsa Abramowitz Stegun

/*
#cgo LDFLAGS: -framework Accelerate
#include <Accelerate/Accelerate.h>
#include <float.h>
#include <math.h>
static void aurialis_stem_softmax(float *values, int rows, int width) {
 // Vector form of: x*0.125 - max(x*0.125), exp, then divide by the double row sum.
 // Scaling by 0.125 is exact, so the shifted values match the scalar form.
 const float scale = 0.125f;
 for (int row=0; row<rows; row++) {
  float *v=values+row*width;
  float maximum;
  vDSP_maxv(v, 1, &maximum, (vDSP_Length)width);
  float shift=-maximum*scale;
  vDSP_vsmsa(v, 1, &scale, &shift, v, 1, (vDSP_Length)width);
 }
 int count=rows*width;
 vvexpf(values, values, &count);
 for (int row=0; row<rows; row++) {
  float *v=values+row*width;
  // Double sum in eight independent lanes so the compiler can vectorize it.
  double lanes[8]={0};
  int col=0;
  for (; col+8<=width; col+=8)
   for (int k=0; k<8; k++) lanes[k]+=(double)v[col+k];
  double sum=((lanes[0]+lanes[1])+(lanes[2]+lanes[3]))+((lanes[4]+lanes[5])+(lanes[6]+lanes[7]));
  for (; col<width; col++) sum+=(double)v[col];
  for (col=0; col<width; col++) v[col]=(float)((double)v[col]/sum);
 }
}
static void aurialis_stem_gelu(float *values, int count) {
 // Exact-form GELU, x/2 * (1 + erf(x/sqrt2)), with erf from Abramowitz and
 // Stegun 7.1.26 (absolute error below 1.5e-7, under float32 resolution near
 // 1). Batches keep exp vectorized; this is not the tanh approximation.
 enum { batch = 1024 };
 float a[batch], t[batch], e[batch];
 for (int first=0; first<count; first+=batch) {
  int n = count-first < batch ? count-first : batch;
  float *x = values+first;
  for (int i=0; i<n; i++) {
   float z = fabsf(x[i])*0.7071067811865475244f;
   a[i] = z;
   t[i] = 1.0f/(1.0f+0.3275911f*z);
   e[i] = -z*z;
  }
  vvexpf(e, e, &n);
  for (int i=0; i<n; i++) {
   float tt = t[i];
   float poly = tt*(0.254829592f+tt*(-0.284496736f+tt*(1.421413741f+tt*(-1.453152027f+tt*1.061405429f))));
   float erfAbs = 1.0f-poly*e[i];
   float erf = x[i] < 0 ? -erfAbs : erfAbs;
   x[i] = 0.5f*x[i]*(1.0f+erf);
  }
 }
 (void)a;
}
static void aurialis_stem_tanh(float *values, int count) {
 vvtanhf(values, values, &count);
}
*/
import "C"

func softmaxBackend(values []float32, rows, width int) {
	C.aurialis_stem_softmax((*C.float)(&values[0]), C.int(rows), C.int(width))
}
func geluBackend(values []float32) {
	C.aurialis_stem_gelu((*C.float)(&values[0]), C.int(len(values)))
}
func tanhBackend(values []float32) {
	C.aurialis_stem_tanh((*C.float)(&values[0]), C.int(len(values)))
}
