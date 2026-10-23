//go:build darwin && cgo

package steminfer

// cspell:words softmax steminfer GELU FLT erff vvexpf vvtanhf

/*
#cgo LDFLAGS: -framework Accelerate
#include <Accelerate/Accelerate.h>
#include <float.h>
#include <math.h>
static void aurialis_stem_softmax(float *values, int rows, int width) {
 for (int row=0; row<rows; row++) {
  float *v=values+row*width;
  float maximum=-FLT_MAX;
  for (int col=0; col<width; col++) { float x=v[col]*0.125f; if(x>maximum) maximum=x; }
  for (int col=0; col<width; col++) v[col]=v[col]*0.125f-maximum;
 }
 int count=rows*width;
 vvexpf(values, values, &count);
 for (int row=0; row<rows; row++) {
  float *v=values+row*width;
  double sum=0;
  for (int col=0; col<width; col++) sum+=(double)v[col];
  for (int col=0; col<width; col++) v[col]=(float)((double)v[col]/sum);
 }
}
static void aurialis_stem_gelu(float *values, int count) {
 // Original exact-form GELU; this is not the tanh approximation.
 for (int i=0; i<count; i++) {
  float x=values[i];
  values[i]=0.5f*x*(1.0f+erff(x*0.7071067811865475244f));
 }
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
