The goal of this directory is to identify the best solution for a backend server for `../minimal/cip-179.md`.
We want something that is lightweight, reliable and fast.
Being able to process the Tx metadata immediately in order to also index the metadata semantically with regard to what interests us (in surveys, votes, cancellations) would also be a bonus.
Otherwise, that can be done as a post process by another stage of the data ingestion.
There are many candidates solutions such as Adder by Blink Labs, Yaci Store by Bloxbean or Oura by TxPipe.

## Adder by Blink Labs

The Adder repo: https://github.com/blinklabs-io/adder
Maybe a useful example: https://github.com/blinklabs-io/cdnsd

## Yaci Store by Bloxbean

The Yaci Store repo: https://github.com/bloxbean/yaci-store
Maybe a useful example: https://github.com/IntersectMBO/administration-data/tree/main/indexer

## Oura by TxPipe

The Oura repo: https://github.com/txpipe/oura
