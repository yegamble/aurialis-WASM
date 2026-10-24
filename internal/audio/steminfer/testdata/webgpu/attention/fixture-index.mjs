// Exact accepted original-v1 trace files. No caller-controlled reference manifest.
export const FIXTURES = Object.freeze([
  {
    "name": "pattern-m1-n1.bin",
    "sha256": "7e3de68b4c8f10b0cdee2a2d340f9af36cb02282d3924ef42a3f3f4eae284341",
    "bytes": 1860,
    "m": 1,
    "n": 1
  },
  {
    "name": "pattern-m1-n15.bin",
    "sha256": "9b12c633d3277f244894184cabf0e8d213edbfd1591c010eb19d051a0509e866",
    "bytes": 9532,
    "m": 1,
    "n": 15
  },
  {
    "name": "pattern-m1-n16.bin",
    "sha256": "cad2f9e4ee10b6b08f9d4730d1569a742a64b9139b35079c73f8ae05cf74cfe9",
    "bytes": 10080,
    "m": 1,
    "n": 16
  },
  {
    "name": "pattern-m3-n17.bin",
    "sha256": "7dd48c931ffa37f924da404491b4e30ffe065523106cb525c853e7ca08a97481",
    "bytes": 14428,
    "m": 3,
    "n": 17
  },
  {
    "name": "pattern-m1-n63.bin",
    "sha256": "a11fbbbb95daaa79bd749aaced9e7337c6b9635159482bd98366a3e2d676c20c",
    "bytes": 35836,
    "m": 1,
    "n": 63
  },
  {
    "name": "pattern-m1-n64.bin",
    "sha256": "7837c68a33d7fd0182902ee7c0ddd85666553746e411bc1eecd8777add6e654d",
    "bytes": 36384,
    "m": 1,
    "n": 64
  },
  {
    "name": "pattern-m3-n65.bin",
    "sha256": "276a20c0b06b301da75685ddfb5f68c2929336426b2474db93d22e7069b6b353",
    "bytes": 44188,
    "m": 3,
    "n": 65
  },
  {
    "name": "pattern-m1-n255.bin",
    "sha256": "af58308fd6a62561d9c0087526a33fd4ded2bf80429744c7092e8d96b728f2b4",
    "bytes": 141052,
    "m": 1,
    "n": 255
  },
  {
    "name": "pattern-m1-n256.bin",
    "sha256": "617aef0c3ff21d64699b37fda2eaaf3a08495de92de3ea2839fcadb5004fd40e",
    "bytes": 141600,
    "m": 1,
    "n": 256
  },
  {
    "name": "pattern-m1-n257.bin",
    "sha256": "ea2815fa2821403beb27951a496984e9a7d28d517da50283a710812e2f795aef",
    "bytes": 142148,
    "m": 1,
    "n": 257
  },
  {
    "name": "pattern-m8-n1723.bin",
    "sha256": "bc0ef1c4e4dc601da031c469109e0df0e81906a614014af43e5fe3430fa08446",
    "bytes": 1388728,
    "m": 8,
    "n": 1723
  },
  {
    "name": "last-key-dominant-m1-n1.bin",
    "sha256": "5362cdcf3676a984a67e21ae272383c911599f19e196221b9de7c65edcbb0b6a",
    "bytes": 1860,
    "m": 1,
    "n": 1
  },
  {
    "name": "last-key-dominant-m1-n16.bin",
    "sha256": "8ef3c3c70c42a2a364db264fe4d4cbf3198dce49e9cde0aec4c95900321733db",
    "bytes": 10080,
    "m": 1,
    "n": 16
  },
  {
    "name": "last-key-dominant-m1-n17.bin",
    "sha256": "7e97f53607c8487508c8723a2e2d17ec4e3805745292b44236b244b3037defd7",
    "bytes": 10628,
    "m": 1,
    "n": 17
  },
  {
    "name": "last-key-dominant-m1-n64.bin",
    "sha256": "0c4fefeeb51e71236a3f3f7a681eed7252b9410b325873bc080a3f9e126218aa",
    "bytes": 36384,
    "m": 1,
    "n": 64
  },
  {
    "name": "last-key-dominant-m1-n65.bin",
    "sha256": "45f11c34eddad1bc98fdb083cee4deb06f1fcb107157d8279c5938c06521f713",
    "bytes": 36932,
    "m": 1,
    "n": 65
  },
  {
    "name": "last-key-dominant-m1-n256.bin",
    "sha256": "6b135a7ee0f45880600060c93279d861147f347d64aef13120dadae89269d118",
    "bytes": 141600,
    "m": 1,
    "n": 256
  },
  {
    "name": "last-key-dominant-m1-n257.bin",
    "sha256": "3d302afdea5e6204699851bc29d9826734fb0905dd982ad203160c8f13240372",
    "bytes": 142148,
    "m": 1,
    "n": 257
  },
  {
    "name": "last-key-dominant-m1-n1723.bin",
    "sha256": "eca22c526c61da00d70df2a6868029ecfb92e9ac16078a2a8c4c361914a0adb9",
    "bytes": 945516,
    "m": 1,
    "n": 1723
  },
  {
    "name": "zero-m3-n65.bin",
    "sha256": "6a4d0ea6ad282c0b11d00717c914da9af11e82b23aef6a1c1fc55e4b30147db0",
    "bytes": 44188,
    "m": 3,
    "n": 65
  },
  {
    "name": "ties-m3-n65.bin",
    "sha256": "2caf47164604811b242cc7f21dbbaf59ef456d861232d1fca5b9e2a6f0e6787a",
    "bytes": 44188,
    "m": 3,
    "n": 65
  },
  {
    "name": "cancellation-m3-n65.bin",
    "sha256": "70208d1a0e0cca8fb66d562d659d2f965cc4a2fed7c46dcd132dfe6a89485aa4",
    "bytes": 44188,
    "m": 3,
    "n": 65
  },
  {
    "name": "high-dynamic-m3-n65.bin",
    "sha256": "6ef553f0a14e64b57e54774b43b0eff26369fdb043ded97f066abdf9693076b4",
    "bytes": 44188,
    "m": 3,
    "n": 65
  },
  {
    "name": "rounding-boundary-m3-n65.bin",
    "sha256": "e94ecb1fa506e99db0e85620857658b1f838601446e609123936154ebf653741",
    "bytes": 44188,
    "m": 3,
    "n": 65
  },
  {
    "name": "subnormal-input-m1-n2.bin",
    "sha256": "6fe442ded6e6cd5a206b34423c228615640cc9b7f9c6ea42829d9f2b80a37305",
    "bytes": 2408,
    "m": 1,
    "n": 2
  },
  {
    "name": "ftz-resurrection-m1-n2.bin",
    "sha256": "d023ddc860c3fba8d82a6c3bdfb2b8f08e76d213a251da3605bc172cefb21177",
    "bytes": 2408,
    "m": 1,
    "n": 2
  },
  {
    "name": "pv-cancellation-m1-n1723.bin",
    "sha256": "df0c6efda09b3f00ca10a53d3b27ef6aa2e8940ef5e1c9b4b97948bb475e085b",
    "bytes": 945516,
    "m": 1,
    "n": 1723
  },
  {
    "name": "normal-exp-boundary-m1-n2.bin",
    "sha256": "ad94202890b3bcea90ae3f9c1437e641ec762bdadbf2a150d5cdf21e0a210799",
    "bytes": 2408,
    "m": 1,
    "n": 2
  }
].map(record => Object.freeze(record)));
