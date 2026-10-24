import json,re
from pathlib import Path
root=Path("/output/ffbuild")
configuration=(root/"config.h").read_text()
components=(root/"config_components.h").read_text()
expected={"DECODER":{"MP3FLOAT","FLAC","VORBIS","AAC","ALAC","OPUS"},"DEMUXER":{"MP3","FLAC","OGG","AAC","MOV"},"PARSER":{"MPEGAUDIO","FLAC","VORBIS","AAC","OPUS"},"ENCODER":set(),"MUXER":set(),"FILTER":set(),"PROTOCOL":set(),"INDEV":set(),"OUTDEV":set(),"HWACCEL":set(),"BSF":set()}
actual={}
for kind,allowed in expected.items():
 actual[kind]=set(re.findall(r"^#define CONFIG_([A-Z0-9_]+)_"+kind+r" 1$",components,re.MULTILINE))
 if actual[kind]!=allowed:raise RuntimeError("Native oracle component mismatch: "+kind)
for key in ["CONFIG_GPL","CONFIG_NONFREE","CONFIG_VERSION3","CONFIG_NETWORK","HAVE_PTHREADS","HAVE_W32THREADS","HAVE_OS2THREADS"]:
 if not re.search(r"^#define "+key+r" 0$",configuration,re.MULTILINE):raise RuntimeError("Native oracle forbidden feature: "+key)
Path("/output/native-component-inventory.json").write_text(json.dumps({k:sorted(v) for k,v in actual.items()},indent=2)+"\n")
