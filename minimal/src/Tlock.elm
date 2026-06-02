module Tlock exposing
    ( decrypt
    , encrypt
    , revealTimeOf
    , roundForDeadline
    )

{-| Drand `tlock` (timelock encryption) bindings for timelocked ballots.

The crypto runs in JS (`static/tlock.js`, Drand quicknet) and is reached through
two `elm-concurrent-task` tasks. Payloads cross the channel as lowercase hex.
The quicknet genesis parameters are hardcoded both here and in the JS bundle.

-}

import ConcurrentTask exposing (ConcurrentTask)
import Json.Decode as JD
import Json.Encode as JE



-- QUICKNET CONSTANTS (see static/tlock.js header)


{-| Drand quicknet genesis time, unix seconds.
-}
genesisTime : Int
genesisTime =
    1692803367


{-| Drand quicknet round period, seconds.
-}
period : Int
period =
    3


{-| Round `R` whose signature publishes at (or just after) `deadlineUnix`.
Matches tlock-js `roundAt`: `floor((t - genesis) / period) + 1`.
-}
roundForDeadline : Int -> Int
roundForDeadline deadlineUnix =
    ((deadlineUnix - genesisTime) // period) + 1


{-| Wall-clock unix seconds at which round `R` becomes decryptable.
-}
revealTimeOf : Int -> Int
revealTimeOf round =
    genesisTime + (round - 1) * period



-- TASKS


{-| Encrypt a hex plaintext to round `R`. Local crypto; returns the
armor-stripped age payload as hex.
-}
encrypt : { round : Int, plaintextHex : String } -> ConcurrentTask String { ciphertextHex : String }
encrypt args =
    ConcurrentTask.define
        { function = "tlock:encrypt"
        , expect =
            ConcurrentTask.expectJson
                (JD.map (\h -> { ciphertextHex = h }) (JD.field "ciphertextHex" JD.string))
        , errors = ConcurrentTask.expectThrows identity
        , args =
            JE.object
                [ ( "round", JE.int args.round )
                , ( "plaintextHex", JE.string args.plaintextHex )
                ]
        }


{-| Decrypt an armor-stripped age payload (hex). Reads the round from the blob,
fetches the round signature from Drand, and decrypts. Fails (throws JS-side) if
the round has not yet been published.
-}
decrypt : { ciphertextHex : String } -> ConcurrentTask String { plaintextHex : String }
decrypt args =
    ConcurrentTask.define
        { function = "tlock:decrypt"
        , expect =
            ConcurrentTask.expectJson
                (JD.map (\h -> { plaintextHex = h }) (JD.field "plaintextHex" JD.string))
        , errors = ConcurrentTask.expectThrows identity
        , args =
            JE.object
                [ ( "ciphertextHex", JE.string args.ciphertextHex ) ]
        }
