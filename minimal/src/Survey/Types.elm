module Survey.Types exposing
    ( AnswerItem(..)
    , BallotMode(..)
    , BallotState(..)
    , NumericConstraints
    , OnchainResponse
    , OnchainSurvey
    , ParsedPayload(..)
    , ResponseAnswers(..)
    , Role(..)
    , SurveyDefinition
    , SurveyQuestion(..)
    , SurveyRef
    , SurveyResponse
    , TimelockConfig
    , WeightingMode(..)
    , allRoles
    , allowedWeightings
    , credentialToHex
    , intToRole
    , intToWeightingMode
    , metadataLabel
    , questionOptions
    , questionPrompt
    , quicknetChainHashHex
    , roleToInt
    , roleToString
    , stringToRole
    , stringToWeightingMode
    , weightingModeToInt
    , weightingModeToString
    , weightingModeToValue
    )

{-| CIP-179 domain types plus the pure enum/accessor helpers shared by the
encoding, decoding, form, and view layers.
-}

import Bytes.Comparable as Bytes exposing (Any, Bytes)
import Cardano.Address exposing (Credential(..))
import Cardano.Metadatum exposing (Metadatum)



-- ============================================================
-- CIP-179 CONSTANTS
-- ============================================================


{-| Metadata label for CIP-179 surveys.
Using 171717 instead of 17 to avoid collisions during experimentation.
-}
metadataLabel : Int
metadataLabel =
    171717


{-| Drand quicknet chain hash (pinned). Matches `static/tlock.js`.
-}
quicknetChainHashHex : String
quicknetChainHashHex =
    "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971"



-- ============================================================
-- CIP-179 TYPES
-- ============================================================


type Role
    = DRep
    | SPO
    | CC
    | Stakeholder


type WeightingMode
    = CredentialBased
    | StakeBased
    | PledgeBased


type alias NumericConstraints =
    { minValue : Int
    , maxValue : Int
    , step : Maybe Int
    }


type SurveyQuestion
    = SingleChoice { prompt : String, options : List String }
    | MultiSelect { prompt : String, options : List String, maxSelections : Int }
    | Ranking { prompt : String, options : List String, maxRanked : Int }
    | NumericRange { prompt : String, constraints : NumericConstraints }
    | Custom { prompt : String, schemaUri : String, schemaHash : Bytes Any }


type alias SurveyDefinition =
    { specVersion : Int
    , owner : Credential
    , title : String
    , description : String
    , roleWeighting : List ( Role, WeightingMode )
    , endEpoch : Int
    , ballotMode : BallotMode
    , questions : List SurveyQuestion
    }


{-| How ballots (responses) are submitted for a survey.

  - `Public`: plaintext answers, as in plain CIP-179.
  - `Timelocked`: answers are Drand `tlock` ciphertext, decryptable by anyone
    once the pinned round publishes. Delayed reveal, not permanent secrecy.

-}
type BallotMode
    = Public
    | Timelocked TimelockConfig


{-| Decryption parameters pinned once in the survey definition so individual
responses don't repeat them. `round` is the Drand quicknet round whose signature
reveals the ballots; `paddingSize` is the minimum plaintext size (bytes) each
ballot is padded to before encryption, to hide answer-content size.
-}
type alias TimelockConfig =
    { chainHash : Bytes Any
    , round : Int
    , paddingSize : Int
    }


type alias SurveyRef =
    { txHash : String
    , index : Int
    }


type alias SurveyResponse =
    { specVersion : Int
    , surveyRef : SurveyRef
    , role : Role
    , responder : Credential
    , answers : ResponseAnswers
    }


{-| A response's answers are either plaintext (public surveys) or a Drand
`tlock` ciphertext blob — the armor-stripped age payload (timelocked surveys),
opaque until the survey's round publishes.
-}
type ResponseAnswers
    = PublicAnswers (List AnswerItem)
    | TimelockedAnswers (Bytes Any)


type AnswerItem
    = AnswerSingleChoice Int Int
    | AnswerMultiSelect Int (List Int)
    | AnswerRanking Int (List Int)
    | AnswerNumeric Int Int
    | AnswerCustom Int Metadatum


type ParsedPayload
    = ParsedDefinitions (List SurveyDefinition)
    | ParsedResponses (List SurveyResponse)
    | ParsedCancellations (List SurveyRef)


type alias OnchainSurvey =
    { txHash : String
    , index : Int
    , definition : SurveyDefinition
    }


type alias OnchainResponse =
    { txHash : String
    , ballotIndex : Int
    , response : SurveyResponse
    }


{-| Per-ballot decryption state for timelocked responses, keyed by ballot key.
-}
type BallotState
    = Decrypting
    | Decrypted (List AnswerItem)
    | DecryptError String



-- ============================================================
-- ENUM CONVERSIONS
-- ============================================================


allRoles : List Role
allRoles =
    [ DRep, SPO, CC, Stakeholder ]


roleToInt : Role -> Int
roleToInt role =
    case role of
        DRep ->
            0

        SPO ->
            1

        CC ->
            2

        Stakeholder ->
            3


intToRole : Int -> Maybe Role
intToRole n =
    case n of
        0 ->
            Just DRep

        1 ->
            Just SPO

        2 ->
            Just CC

        3 ->
            Just Stakeholder

        _ ->
            Nothing


roleToString : Role -> String
roleToString role =
    case role of
        DRep ->
            "DRep"

        SPO ->
            "SPO"

        CC ->
            "CC"

        Stakeholder ->
            "Stakeholder"


stringToRole : String -> Maybe Role
stringToRole s =
    case s of
        "DRep" ->
            Just DRep

        "SPO" ->
            Just SPO

        "CC" ->
            Just CC

        "Stakeholder" ->
            Just Stakeholder

        _ ->
            Nothing


weightingModeToInt : WeightingMode -> Int
weightingModeToInt wm =
    case wm of
        CredentialBased ->
            0

        StakeBased ->
            1

        PledgeBased ->
            2


intToWeightingMode : Int -> Maybe WeightingMode
intToWeightingMode n =
    case n of
        0 ->
            Just CredentialBased

        1 ->
            Just StakeBased

        2 ->
            Just PledgeBased

        _ ->
            Nothing


weightingModeToString : WeightingMode -> String
weightingModeToString wm =
    case wm of
        CredentialBased ->
            "Credential-based"

        StakeBased ->
            "Stake-based"

        PledgeBased ->
            "Pledge-based"


weightingModeToValue : WeightingMode -> String
weightingModeToValue wm =
    case wm of
        CredentialBased ->
            "credential"

        StakeBased ->
            "stake"

        PledgeBased ->
            "pledge"


stringToWeightingMode : String -> WeightingMode
stringToWeightingMode s =
    case s of
        "stake" ->
            StakeBased

        "pledge" ->
            PledgeBased

        _ ->
            CredentialBased


allowedWeightings : Role -> List WeightingMode
allowedWeightings role =
    case role of
        DRep ->
            [ CredentialBased, StakeBased ]

        SPO ->
            [ CredentialBased, StakeBased, PledgeBased ]

        CC ->
            [ CredentialBased ]

        Stakeholder ->
            [ StakeBased ]



-- ============================================================
-- DOMAIN ACCESSORS
-- ============================================================


credentialToHex : Credential -> String
credentialToHex cred =
    case cred of
        VKeyHash hash ->
            Bytes.toHex (Bytes.toAny hash)

        ScriptHash hash ->
            Bytes.toHex (Bytes.toAny hash)


questionPrompt : SurveyQuestion -> String
questionPrompt q =
    case q of
        SingleChoice { prompt } ->
            prompt

        MultiSelect { prompt } ->
            prompt

        Ranking { prompt } ->
            prompt

        NumericRange { prompt } ->
            prompt

        Custom { prompt } ->
            prompt


questionOptions : SurveyQuestion -> List String
questionOptions q =
    case q of
        SingleChoice { options } ->
            options

        MultiSelect { options } ->
            options

        Ranking { options } ->
            options

        _ ->
            []
