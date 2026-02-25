[0m[38;5;245m    CPU | 11th Gen Intel(R) Core(TM) i7-11700K @ 3.60GHz[0m
[0m[38;5;245mRuntime | Deno 2.6.10 (x86_64-unknown-linux-gnu)[0m

[0m[38;5;245mfile:///home/sandwich/Develop/blssm.us/src/middleware/bench.ts[0m

| benchmark                                               | time/iter (avg) |        iter/s |      (min … max)      |      p75 |      p99 |     p995 |
| ------------------------------------------------------- | --------------- | ------------- | --------------------- | -------- | -------- | -------- |
| normalizeCacheConfig: valid input                       | [0m[33m         3.5 ns[0m |   286,500,000 | ([0m[36m  3.2 ns[0m … [0m[35m 10.5 ns[0m) |[0m[35m   3.5 ns |   6.1 ns |   7.5 ns |[0m
| normalizeCacheConfig: null input (defaults)             | [0m[33m         9.8 ns[0m |   102,300,000 | ([0m[36m  8.1 ns[0m … [0m[35m 23.6 ns[0m) |[0m[35m   9.9 ns |  15.6 ns |  16.8 ns |[0m
| normalizeCacheConfig: partial input                     | [0m[33m         4.7 ns[0m |   214,200,000 | ([0m[36m  3.9 ns[0m … [0m[35m 16.0 ns[0m) |[0m[35m   4.5 ns |   8.6 ns |   9.2 ns |[0m
| normalizePaymentConfig: valid 2-mint config             | [0m[33m         1.0 µs[0m |       991,300 | ([0m[36m970.6 ns[0m … [0m[35m  1.3 µs[0m) |[0m[35m   1.0 µs |   1.3 µs |   1.3 µs |[0m
| normalizePaymentConfig: malformed (string)              | [0m[33m         9.2 ns[0m |   109,200,000 | ([0m[36m  7.8 ns[0m … [0m[35m 22.6 ns[0m) |[0m[35m   9.2 ns |  14.0 ns |  15.1 ns |[0m
| paymentsEnabled: enabled (2 mints)                      | [0m[33m         3.3 ns[0m |   299,900,000 | ([0m[36m  3.1 ns[0m … [0m[35m  6.0 ns[0m) |[0m[35m   3.4 ns |   4.3 ns |   4.6 ns |[0m
| paymentsEnabled: disabled (0 mints)                     | [0m[33m         3.3 ns[0m |   303,500,000 | ([0m[36m  3.0 ns[0m … [0m[35m 12.5 ns[0m) |[0m[35m   3.3 ns |   6.0 ns |   6.3 ns |[0m
| computeSatPrice: 1 GB @ $100k BTC                       | [0m[33m         3.3 ns[0m |   307,600,000 | ([0m[36m  3.0 ns[0m … [0m[35m  5.5 ns[0m) |[0m[35m   3.3 ns |   4.2 ns |   4.4 ns |[0m
| computeSatPrice: 10 MB @ $50k BTC                       | [0m[33m         3.1 ns[0m |   319,400,000 | ([0m[36m  2.9 ns[0m … [0m[35m  6.7 ns[0m) |[0m[35m   3.2 ns |   4.5 ns |   4.8 ns |[0m
| computeSatPrice: 0 bytes (floor)                        | [0m[33m         3.1 ns[0m |   321,800,000 | ([0m[36m  2.9 ns[0m … [0m[35m  5.9 ns[0m) |[0m[35m   3.1 ns |   4.2 ns |   4.5 ns |[0m
| validateTokenStructure: valid (4 proofs)                | [0m[33m         8.6 ns[0m |   116,800,000 | ([0m[36m  7.8 ns[0m … [0m[35m 16.0 ns[0m) |[0m[35m   8.7 ns |  11.0 ns |  11.7 ns |[0m
| validateTokenStructure: untrusted mint (early reject)   | [0m[33m         6.5 ns[0m |   153,200,000 | ([0m[36m  5.9 ns[0m … [0m[35m 12.0 ns[0m) |[0m[35m   6.6 ns |   8.6 ns |   9.3 ns |[0m
| validateTokenStructure: insufficient amount             | [0m[33m         6.8 ns[0m |   146,600,000 | ([0m[36m  6.1 ns[0m … [0m[35m 11.1 ns[0m) |[0m[35m   7.0 ns |   8.8 ns |   9.4 ns |[0m
| isProofSpent: miss                                      | [0m[33m        11.1 ns[0m |    89,900,000 | ([0m[36m 10.4 ns[0m … [0m[35m 18.6 ns[0m) |[0m[35m  11.3 ns |  13.3 ns |  14.3 ns |[0m
| isProofSpent: hit                                       | [0m[33m         5.4 ns[0m |   186,600,000 | ([0m[36m  5.0 ns[0m … [0m[35m  8.8 ns[0m) |[0m[35m   5.4 ns |   6.8 ns |   7.2 ns |[0m
| addToSpentCache: 4 secrets                              | [0m[33m        17.2 ns[0m |    58,300,000 | ([0m[36m 15.5 ns[0m … [0m[35m 30.7 ns[0m) |[0m[35m  17.7 ns |  19.7 ns |  20.7 ns |[0m
| buildPaymentError: 400 (untrusted_mint)                 | [0m[33m       618.8 ns[0m |     1,616,000 | ([0m[36m580.9 ns[0m … [0m[35m836.3 ns[0m) |[0m[35m 625.5 ns | 836.3 ns | 836.3 ns |[0m
| buildPaymentError: 503 (mint_unreachable)               | [0m[33m       781.9 ns[0m |     1,279,000 | ([0m[36m736.3 ns[0m … [0m[35m859.1 ns[0m) |[0m[35m 793.3 ns | 859.1 ns | 859.1 ns |[0m
| buildPaymentRequired: 10 MB file, 2 mints               | [0m[33m         9.5 µs[0m |       105,400 | ([0m[36m  4.2 µs[0m … [0m[35m126.2 µs[0m) |[0m[35m  14.0 µs |  24.4 µs |  27.7 µs |[0m
| buildPaymentRequired: 1 GB file, 1 mint                 | [0m[33m         9.4 µs[0m |       106,600 | ([0m[36m  9.1 µs[0m … [0m[35m  9.6 µs[0m) |[0m[35m   9.5 µs |   9.6 µs |   9.6 µs |[0m
| paymentGate fast-path simulation: payments disabled     | [0m[33m        10.2 ns[0m |    97,620,000 | ([0m[36m  8.8 ns[0m … [0m[35m 20.9 ns[0m) |[0m[35m  10.3 ns |  15.1 ns |  15.9 ns |[0m

