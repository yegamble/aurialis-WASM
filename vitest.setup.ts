// Memory-admission tests assume a mid-range (4 GB) device: a 512 MiB local audio budget.
Object.defineProperty(navigator, "deviceMemory", { configurable: true, value: 4 });
