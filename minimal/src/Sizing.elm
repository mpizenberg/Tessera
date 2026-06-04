module Sizing exposing
    ( Ciphertext
    , Effect(..)
    , Msg
    , Params
    , QType
    , State
    , Target
    , encryptRound
    , init
    , setCiphertext
    , update
    , view
    )

{-| Hidden `?page=sizing` diagnostics page. Builds real, fully-signed CIP-179
transactions from adjustable parameters and reports their on-chain byte size
against the `maxTxSize` budget — so we can measure, for this CIP, how many
questions / options / characters actually fit, for both survey definitions and
(public + timelocked) responses.

The transaction context is fabricated (one ADA input, change back to the same
address, the definition/response credential in `required_signers`, two
placeholder vkey witnesses) so no wallet or chain access is needed. The only
non-pure quantity is the timelocked ciphertext, which is produced by the real
`tlock` encryption (local crypto, hardcoded round) via an `Effect` the host
interprets.

-}

import Bytes.Comparable as Bytes
import Cardano.Address as Address exposing (Credential(..), NetworkId)
import Cardano.Metadatum as Metadatum exposing (Metadatum(..))
import Cardano.Transaction as Transaction
import Cardano.TxIntent as TxIntent exposing (SpendSource(..), TxIntent(..), TxOtherInfo(..))
import Cardano.Utxo as Utxo
import Cardano.Value as Value
import Cbor.Encode
import Html exposing (Html, button, div, h2, h3, input, label, p, span, text)
import Html.Attributes as HA
import Html.Events exposing (onClick, onInput)
import Natural as N
import Survey.Codec as Codec
import Survey.Labels as Labels
import Survey.Types as ST exposing (Role(..), SubmissionMode(..), SurveyQuestion(..), WeightingMode(..))



-- CONSTANTS


{-| Conway `maxTxSize` protocol parameter (mainnet). The hard ceiling every
fully-signed transaction must fit under.
-}
maxTxSize : Int
maxTxSize =
    16384


{-| Drand quicknet round to encrypt timelocked responses to. Any round works for
sizing (encryption is local and round only contributes a small integer to the
age stanza); a long-past round keeps it concrete.
-}
encryptRound : Int
encryptRound =
    1



-- MODEL


type Target
    = DefinitionTarget
    | PublicResponseTarget
    | TimelockedResponseTarget


type QType
    = QSingle
    | QMulti
    | QRanking


type alias Params =
    { target : Target
    , qType : QType
    , numQuestions : Int
    , optionsPerQuestion : Int
    , titleChars : Int
    , descChars : Int
    , promptChars : Int
    , optionChars : Int
    , answeredCount : Int
    , selectionsPerAnswer : Int
    }


{-| Latest timelocked ciphertext (hex) for the current params, or its async state.
-}
type Ciphertext
    = CtIdle
    | CtEncrypting
    | CtReady String
    | CtFailed String


type alias State =
    { params : Params
    , ciphertext : Ciphertext
    }


defaultParams : Params
defaultParams =
    { target = DefinitionTarget
    , qType = QSingle
    , numQuestions = 1
    , optionsPerQuestion = 2
    , titleChars = 0
    , descChars = 0
    , promptChars = 0
    , optionChars = 0
    , answeredCount = 1
    , selectionsPerAnswer = 2
    }


init : State
init =
    { params = defaultParams, ciphertext = CtIdle }



-- KNOBS / TEMPLATES


type Knob
    = NumQuestions
    | OptionsPerQuestion
    | TitleChars
    | DescChars
    | PromptChars
    | OptionChars
    | AnsweredCount
    | SelectionsPerAnswer


knobValue : Knob -> Params -> Int
knobValue knob p =
    case knob of
        NumQuestions ->
            p.numQuestions

        OptionsPerQuestion ->
            p.optionsPerQuestion

        TitleChars ->
            p.titleChars

        DescChars ->
            p.descChars

        PromptChars ->
            p.promptChars

        OptionChars ->
            p.optionChars

        AnsweredCount ->
            p.answeredCount

        SelectionsPerAnswer ->
            p.selectionsPerAnswer


setKnob : Knob -> Int -> Params -> Params
setKnob knob v p =
    case knob of
        NumQuestions ->
            { p | numQuestions = v }

        OptionsPerQuestion ->
            { p | optionsPerQuestion = v }

        TitleChars ->
            { p | titleChars = v }

        DescChars ->
            { p | descChars = v }

        PromptChars ->
            { p | promptChars = v }

        OptionChars ->
            { p | optionChars = v }

        AnsweredCount ->
            { p | answeredCount = v }

        SelectionsPerAnswer ->
            { p | selectionsPerAnswer = v }


{-| Upper bound for a knob's slider / fill-to-max search. Generous; the real
limit is found by measuring against the budget.
-}
knobMax : Knob -> Int
knobMax knob =
    case knob of
        NumQuestions ->
            4000

        OptionsPerQuestion ->
            16000

        TitleChars ->
            16000

        DescChars ->
            16000

        PromptChars ->
            256

        OptionChars ->
            128

        AnsweredCount ->
            4000

        SelectionsPerAnswer ->
            6000


type Template
    = TplFloor
    | TplMaxDesc
    | TplMaxQuestions
    | TplMaxOptions
    | TplPublicResponse
    | TplTimelockedResponse


applyTemplate : Template -> Params
applyTemplate tpl =
    case tpl of
        TplFloor ->
            { defaultParams | target = DefinitionTarget, qType = QSingle, numQuestions = 1, optionsPerQuestion = 2 }

        TplMaxDesc ->
            { defaultParams | target = DefinitionTarget, qType = QSingle, numQuestions = 1, optionsPerQuestion = 2, descChars = 8000 }

        TplMaxQuestions ->
            { defaultParams | target = DefinitionTarget, qType = QSingle, numQuestions = 2000, optionsPerQuestion = 2 }

        TplMaxOptions ->
            { defaultParams | target = DefinitionTarget, qType = QRanking, numQuestions = 1, optionsPerQuestion = 8000 }

        TplPublicResponse ->
            { defaultParams | target = PublicResponseTarget, qType = QSingle, answeredCount = 2000 }

        TplTimelockedResponse ->
            { defaultParams | target = TimelockedResponseTarget, qType = QSingle, answeredCount = 10 }



-- MSG / UPDATE


type Msg
    = SetTarget Target
    | SetQType QType
    | SetInt Knob String
    | FillMax Knob
    | LoadTemplate Template


{-| Side effect the host must run: encrypt this plaintext (hex) to `encryptRound`
and report back via `setCiphertext`.
-}
type Effect
    = NoEffect
    | Encrypt String


update : Msg -> State -> ( State, Effect )
update msg state =
    let
        p =
            state.params
    in
    case msg of
        SetTarget target ->
            refresh { state | params = { p | target = target } }

        SetQType qt ->
            refresh { state | params = { p | qType = qt } }

        SetInt knob raw ->
            let
                v =
                    String.toInt raw |> Maybe.withDefault 0 |> clamp 0 (knobMax knob)
            in
            refresh { state | params = setKnob knob v p }

        FillMax knob ->
            refresh { state | params = setKnob knob (fitKnob knob p) p }

        LoadTemplate tpl ->
            refresh { state | params = applyTemplate tpl }


params_ : State -> Params
params_ =
    .params


{-| After any param change, (re)trigger timelocked encryption when relevant.
-}
refresh : State -> ( State, Effect )
refresh state =
    case (params_ state).target of
        TimelockedResponseTarget ->
            ( { state | ciphertext = CtEncrypting }
            , Encrypt (timelockedPlaintextHex (params_ state))
            )

        _ ->
            ( { state | ciphertext = CtIdle }, NoEffect )


{-| Store the result of the host's `tlock` encryption.
-}
setCiphertext : Result String String -> State -> State
setCiphertext result state =
    case result of
        Ok hex ->
            { state | ciphertext = CtReady hex }

        Err err ->
            { state | ciphertext = CtFailed err }



-- FABRICATION HELPERS


ownerKeyHash : Bytes.Bytes a
ownerKeyHash =
    Bytes.dummy 28 "owner"


responderKeyHash : Bytes.Bytes a
responderKeyHash =
    Bytes.dummy 28 "responder"


dummyRef : ST.SurveyRef
dummyRef =
    { txHash = String.repeat 64 "0", index = 0 }


{-| n ASCII bytes (1 byte/char), the worst case for character capacity in UTF-8.
-}
txt : Int -> String
txt n =
    String.repeat (max 0 n) "a"


mkQuestion : Params -> SurveyQuestion
mkQuestion p =
    let
        prompt =
            txt p.promptChars

        opts =
            List.repeat p.optionsPerQuestion (txt p.optionChars)
    in
    case p.qType of
        QSingle ->
            SingleChoice { prompt = prompt, options = opts }

        QMulti ->
            MultiSelect { prompt = prompt, options = opts, maxSelections = p.optionsPerQuestion }

        QRanking ->
            Ranking { prompt = prompt, options = opts, maxRanked = p.optionsPerQuestion }


definition : Params -> ST.SurveyDefinition
definition p =
    { specVersion = 3
    , owner = VKeyHash ownerKeyHash
    , title = txt p.titleChars
    , description = txt p.descChars
    , roleWeighting = [ ( DRep, StakeBased ) ]
    , endEpoch = 1000
    , submissionMode = Public
    , questions = List.repeat p.numQuestions (mkQuestion p)
    }


{-| One answer item `[tag, qIdx, value]` for question `qIdx`, matching the
question type chosen for the (hypothetical) target survey.
-}
answerMeta : Params -> Int -> Metadatum
answerMeta p qIdx =
    let
        selections =
            List.map Codec.metaInt (List.range 0 (max 0 (p.selectionsPerAnswer - 1)))
    in
    case p.qType of
        QSingle ->
            List [ Codec.metaInt 0, Codec.metaInt qIdx, Codec.metaInt 0 ]

        QMulti ->
            List [ Codec.metaInt 1, Codec.metaInt qIdx, List selections ]

        QRanking ->
            List [ Codec.metaInt 2, Codec.metaInt qIdx, List selections ]


encodedAnswers : Params -> List Metadatum
encodedAnswers p =
    List.map (answerMeta p) (List.range 0 (p.answeredCount - 1))


publicResponseMeta : Params -> Metadatum
publicResponseMeta p =
    Codec.responseEnvelope dummyRef DRep (VKeyHash responderKeyHash) (List (encodedAnswers p))


timelockedPlaintextHex : Params -> String
timelockedPlaintextHex p =
    -- No artificial padding here: we want the true size of the real answers.
    Codec.plaintextHexForAnswers 0 (encodedAnswers p)


timelockedResponseMeta : String -> Metadatum
timelockedResponseMeta ciphertextHex =
    Codec.buildTimelockedResponseMetadatum dummyRef DRep (VKeyHash responderKeyHash) (Bytes.fromHexUnchecked ciphertextHex)



-- MEASUREMENT


type alias Report =
    { totalSize : Int
    , payloadBytes : Int
    , feeLovelace : Int
    }


{-| The CIP-179 metadatum, its secondary-index marker label, and the credential
that goes in `required_signers`, for the current target. `Nothing` when a
timelocked response has no ciphertext yet.
-}
metaForTarget : Params -> Ciphertext -> Maybe { meta : Metadatum, markerTag : Int, signer : Bytes.Bytes Address.CredentialHash }
metaForTarget p ct =
    case p.target of
        DefinitionTarget ->
            Just
                { meta = Codec.toMetadatum (definition p)
                , markerTag = Labels.definitionsLabel
                , signer = ownerKeyHash
                }

        PublicResponseTarget ->
            Just
                { meta = publicResponseMeta p
                , markerTag = Labels.responseLabel dummyRef
                , signer = responderKeyHash
                }

        TimelockedResponseTarget ->
            case ct of
                CtReady hex ->
                    Just
                        { meta = timelockedResponseMeta hex
                        , markerTag = Labels.responseLabel dummyRef
                        , signer = responderKeyHash
                        }

                _ ->
                    Nothing


{-| Build the fabricated, fully-signed transaction for a metadatum and measure it.
-}
measureMeta : NetworkId -> { meta : Metadatum, markerTag : Int, signer : Bytes.Bytes Address.CredentialHash } -> Result String Report
measureMeta networkId { meta, markerTag, signer } =
    let
        feeAddr =
            Address.enterprise networkId (Bytes.dummy 28 "fee")

        inputRef =
            { transactionId = Bytes.dummy 32 "input", outputIndex = 0 }

        localStateUtxos =
            Utxo.refDictFromList
                [ ( inputRef, Utxo.fromLovelace feeAddr (N.fromSafeInt 1000000000) ) ]

        otherInfo =
            [ TxMetadata { tag = N.fromSafeInt Labels.metadataLabel, metadata = meta }
            , TxMetadata { tag = N.fromSafeInt markerTag, metadata = List [] }
            , TxRequiredSigner signer
            ]

        intents =
            [ Spend (FromWallet { address = feeAddr, value = Value.onlyLovelace N.zero, guaranteedUtxos = [] }) ]
    in
    case TxIntent.finalize localStateUtxos otherInfo intents of
        Err err ->
            Err (TxIntent.errorToString err)

        Ok { tx, expectedSignatures } ->
            let
                n =
                    max 1 (List.length expectedSignatures)

                witnesses =
                    List.map
                        (\i ->
                            { vkey = Bytes.dummy 32 ("vkey" ++ String.fromInt i)
                            , signature = Bytes.dummy 64 ("sig" ++ String.fromInt i)
                            }
                        )
                        (List.range 1 n)

                signedTx =
                    Transaction.updateSignatures (\_ -> Just witnesses) tx
            in
            Ok
                { totalSize = Bytes.width (Transaction.serialize signedTx)
                , payloadBytes = Bytes.width (Bytes.fromBytes (Cbor.Encode.encode (Metadatum.toCbor meta)))
                , feeLovelace = N.toInt signedTx.body.fee
                }


measure : NetworkId -> State -> Result String Report
measure networkId state =
    case metaForTarget (params_ state) state.ciphertext of
        Just info ->
            measureMeta networkId info

        Nothing ->
            case state.ciphertext of
                CtFailed err ->
                    Err ("Timelock encryption failed: " ++ err)

                _ ->
                    Err "Encrypting timelocked response…"


{-| Largest value of `knob` (other params fixed) whose signed tx still fits the
budget. Pure binary search; only valid for non-timelocked knobs.
-}
fitKnob : Knob -> Params -> Int
fitKnob knob p =
    let
        fitsAt v =
            case metaForTarget (setKnob knob v p) CtIdle of
                Nothing ->
                    False

                Just info ->
                    case measureMeta Address.Mainnet info of
                        Ok report ->
                            report.totalSize <= maxTxSize

                        Err _ ->
                            False

        search lo hi =
            if lo >= hi then
                lo

            else
                let
                    mid =
                        lo + (hi - lo + 1) // 2
                in
                if fitsAt mid then
                    search mid hi

                else
                    search lo (mid - 1)
    in
    search 0 (knobMax knob)



-- VIEW


view : NetworkId -> State -> Html Msg
view networkId state =
    let
        p =
            params_ state
    in
    div [ HA.style "max-width" "760px" ]
        [ h2 [] [ text "CIP-179 transaction-size explorer" ]
        , p_ "Builds a real, fully-signed transaction (1 ADA input, change to the same address, the definition/response credential in required_signers, 2 placeholder witnesses) and measures its on-chain size against maxTxSize."
        , viewTemplates
        , viewTargetPicker p
        , viewControls p
        , viewReport networkId state
        ]


p_ : String -> Html msg
p_ s =
    p [ HA.style "color" "#555", HA.style "font-size" "0.9em" ] [ text s ]


viewTemplates : Html Msg
viewTemplates =
    div [ HA.style "margin" "0.75rem 0" ]
        [ h3 [] [ text "Templates" ]
        , div [ HA.style "display" "flex", HA.style "flex-wrap" "wrap", HA.style "gap" "0.5rem" ]
            [ tplBtn TplFloor "Definition floor"
            , tplBtn TplMaxDesc "Max description"
            , tplBtn TplMaxQuestions "Max questions"
            , tplBtn TplMaxOptions "Max options (ranking)"
            , tplBtn TplPublicResponse "Public response"
            , tplBtn TplTimelockedResponse "Timelocked response"
            ]
        ]


tplBtn : Template -> String -> Html Msg
tplBtn tpl lbl =
    button [ HA.class "btn", onClick (LoadTemplate tpl) ] [ text lbl ]


viewTargetPicker : Params -> Html Msg
viewTargetPicker p =
    div [ HA.style "margin" "0.75rem 0" ]
        [ h3 [] [ text "Target" ]
        , radio "Survey definition" (p.target == DefinitionTarget) (SetTarget DefinitionTarget)
        , radio "Public response" (p.target == PublicResponseTarget) (SetTarget PublicResponseTarget)
        , radio "Timelocked response" (p.target == TimelockedResponseTarget) (SetTarget TimelockedResponseTarget)
        ]


viewControls : Params -> Html Msg
viewControls p =
    let
        controlSliders =
            case p.target of
                DefinitionTarget ->
                    [ slider NumQuestions p True
                    , slider OptionsPerQuestion p True
                    , slider OptionChars p False
                    , slider PromptChars p False
                    , slider TitleChars p False
                    , slider DescChars p True
                    ]

                _ ->
                    slider AnsweredCount p (p.target == PublicResponseTarget)
                        :: (if p.qType /= QSingle then
                                [ slider SelectionsPerAnswer p False ]

                            else
                                []
                           )
    in
    div [ HA.style "margin" "0.75rem 0" ]
        (h3 [] [ text "Controls" ]
            :: qTypePicker p
            :: controlSliders
        )


qTypePicker : Params -> Html Msg
qTypePicker p =
    div [ HA.style "margin" "0.5rem 0" ]
        [ span [ HA.style "font-weight" "bold", HA.style "margin-right" "0.5rem" ] [ text "Question type:" ]
        , radio "Single-choice" (p.qType == QSingle) (SetQType QSingle)
        , radio "Multi-select" (p.qType == QMulti) (SetQType QMulti)
        , radio "Ranking" (p.qType == QRanking) (SetQType QRanking)
        ]


radio : String -> Bool -> Msg -> Html Msg
radio lbl checked msg =
    label [ HA.style "margin-right" "1rem", HA.style "cursor" "pointer" ]
        [ input [ HA.type_ "radio", HA.checked checked, onClick msg ] []
        , text (" " ++ lbl)
        ]


{-| One labelled range slider; `withFill` adds a fill-to-max button.
-}
slider : Knob -> Params -> Bool -> Html Msg
slider knob p withFill =
    let
        v =
            knobValue knob p
    in
    div [ HA.style "margin" "0.4rem 0", HA.style "display" "flex", HA.style "align-items" "center", HA.style "gap" "0.5rem" ]
        [ span [ HA.style "width" "180px", HA.style "font-size" "0.9em" ] [ text (knobLabel knob) ]
        , input
            [ HA.type_ "range"
            , HA.min "0"
            , HA.max (String.fromInt (knobMax knob))
            , HA.value (String.fromInt v)
            , onInput (SetInt knob)
            , HA.style "flex" "1"
            ]
            []
        , input
            [ HA.type_ "number"
            , HA.min "0"
            , HA.max (String.fromInt (knobMax knob))
            , HA.value (String.fromInt v)
            , onInput (SetInt knob)
            , HA.style "width" "80px"
            ]
            []
        , if withFill then
            button [ HA.class "btn btn-sm", onClick (FillMax knob) ] [ text "max" ]

          else
            text ""
        ]


knobLabel : Knob -> String
knobLabel knob =
    case knob of
        NumQuestions ->
            "Questions"

        OptionsPerQuestion ->
            "Options / question"

        TitleChars ->
            "Title chars"

        DescChars ->
            "Description chars"

        PromptChars ->
            "Prompt chars / question"

        OptionChars ->
            "Option label chars"

        AnsweredCount ->
            "Questions answered"

        SelectionsPerAnswer ->
            "Selections / answer"


viewReport : NetworkId -> State -> Html Msg
viewReport networkId state =
    div [ HA.style "margin-top" "1rem", HA.class "survey-card" ]
        [ h3 [] [ text "Result" ]
        , case measure networkId state of
            Err err ->
                p [ HA.class "meta" ] [ text err ]

            Ok report ->
                let
                    pct =
                        toFloat report.totalSize / toFloat maxTxSize * 100

                    over =
                        report.totalSize > maxTxSize

                    barColor =
                        if over then
                            "#c0392b"

                        else if pct > 80 then
                            "#e67e22"

                        else
                            "#27ae60"
                in
                div []
                    [ p []
                        [ span [ HA.style "font-size" "1.4em", HA.style "font-weight" "bold" ]
                            [ text (String.fromInt report.totalSize ++ " B") ]
                        , text (" / " ++ String.fromInt maxTxSize ++ " B signed tx  (" ++ formatPct pct ++ "%)")
                        ]
                    , div
                        [ HA.style "height" "16px"
                        , HA.style "background" "#eee"
                        , HA.style "border-radius" "4px"
                        , HA.style "overflow" "hidden"
                        ]
                        [ div
                            [ HA.style "height" "100%"
                            , HA.style "width" (formatPct (min 100 pct) ++ "%")
                            , HA.style "background" barColor
                            ]
                            []
                        ]
                    , p [ HA.class "meta", HA.style "margin-top" "0.5rem" ]
                        [ text ("CIP-179 metadata payload: " ++ String.fromInt report.payloadBytes ++ " B") ]
                    , p [ HA.class "meta" ]
                        [ text ("Tx overhead (body + witnesses + envelope): " ++ String.fromInt (report.totalSize - report.payloadBytes) ++ " B") ]
                    , p [ HA.class "meta" ]
                        [ text ("Estimated Tx fee: " ++ formatAda report.feeLovelace ++ " ADA") ]
                    , if over then
                        p [ HA.class "error" ] [ text "Over budget — this transaction would be rejected." ]

                      else
                        text ""
                    ]
        ]


{-| Lovelace as a fixed 6-decimal ADA string (1 ADA = 1,000,000 lovelace).
-}
formatAda : Int -> String
formatAda lovelace =
    let
        ada =
            lovelace // 1000000

        frac =
            modBy 1000000 lovelace

        fracStr =
            String.padLeft 6 '0' (String.fromInt frac)
                |> String.left 3
    in
    String.fromInt ada ++ "." ++ fracStr


formatPct : Float -> String
formatPct f =
    let
        scaled =
            round (f * 10)
    in
    String.fromInt (scaled // 10) ++ "." ++ String.fromInt (modBy 10 (abs scaled))
