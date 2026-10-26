/** Source limits shared with Go CDR (`audio.MaxDecodedFrames`) and the job worker. */
export const MAX_SOURCE_FRAMES = 33_554_432;
/** One maximum canonical stereo-float WAV, including its 44-byte header. */
export const MAX_SOURCE_BYTES = MAX_SOURCE_FRAMES * 8 + 44;
/** Combined binary inputs for one local job (`browserjobs.MaxInputBytes`). */
export const MAX_JOB_INPUT_BYTES = 257 * 1024 * 1024;
