module Survey.Form exposing
    ( AnswerForm(..)
    , FormMsg(..)
    , QuestionForm
    , QuestionType(..)
    , ResponseForm
    , ResponseFormMsg(..)
    , RoleWeightingEntry
    , SurveyForm
    , allQuestionTypes
    , buildResponseMetadatum
    , emptyForm
    , encodeResponseAnswers
    , formMaxPlaintextSize
    , formToDefinition
    , initResponseForm
    , questionTypeToString
    , questionTypeToValue
    , updateForm
    , updateResponseForm
    )

{-| Survey creation + response form state, validation, and the form->metadatum
encoders. The editor/UI state machine, separate from the wire codec and views.
-}

import Bytes.Comparable as Bytes
import Cardano.Address exposing (Credential(..))
import Cardano.Metadatum exposing (Metadatum(..))
import List.Extra
import Survey.Codec exposing (maxPlaintextSize, metaInt, metaStr, responseEnvelope, resultApply, traverseResults)
import Survey.Types exposing (..)
import Tlock



-- ============================================================
-- STRING HELPERS
-- ============================================================


questionTypeToString : QuestionType -> String
questionTypeToString qt =
    case qt of
        SingleChoiceType ->
            "Single choice"

        MultiSelectType ->
            "Multi-select"

        RankingType ->
            "Ranking"

        NumericRangeType ->
            "Numeric range"

        CustomType ->
            "Custom"



-- ============================================================
-- FORM TYPES
-- ============================================================


type QuestionType
    = SingleChoiceType
    | MultiSelectType
    | RankingType
    | NumericRangeType
    | CustomType


allQuestionTypes : List QuestionType
allQuestionTypes =
    [ SingleChoiceType, MultiSelectType, RankingType, NumericRangeType, CustomType ]


type alias QuestionForm =
    { questionType : QuestionType
    , prompt : String
    , options : List String
    , maxSelections : String
    , maxRanked : String
    , minValue : String
    , maxValue : String
    , step : String
    , schemaUri : String
    , schemaHash : String
    }


type alias RoleWeightingEntry =
    { role : Role
    , enabled : Bool
    , weightingMode : WeightingMode
    }


type alias SurveyForm =
    { title : String
    , description : String
    , questions : List QuestionForm
    , roleWeightings : List RoleWeightingEntry
    , endEpoch : String
    , ownerKeyHash : String
    , timelocked : Bool
    , revealMinutes : String
    , paddingSize : String
    }


type FormMsg
    = SetTitle String
    | SetDescription String
    | SetEndEpoch String
    | SetOwnerKeyHash String
    | AddQuestion
    | RemoveQuestion Int
    | SetQuestionType Int String
    | SetPrompt Int String
    | AddOption Int
    | RemoveOption Int Int
    | SetOption Int Int String
    | SetMaxSelections Int String
    | SetMaxRanked Int String
    | SetMinValue Int String
    | SetMaxValue Int String
    | SetStep Int String
    | SetSchemaUri Int String
    | SetSchemaHash Int String
    | ToggleRole Role
    | SetWeighting Role String
    | SetTimelocked Bool
    | SetRevealMinutes String
    | SetPaddingSize String
    | SubmitSurvey



-- ============================================================
-- FORM LOGIC
-- ============================================================


emptyQuestion : QuestionForm
emptyQuestion =
    { questionType = SingleChoiceType
    , prompt = ""
    , options = [ "", "" ]
    , maxSelections = "2"
    , maxRanked = "2"
    , minValue = "0"
    , maxValue = "100"
    , step = ""
    , schemaUri = ""
    , schemaHash = ""
    }


emptyForm : SurveyForm
emptyForm =
    { title = ""
    , description = ""
    , questions = [ emptyQuestion ]
    , roleWeightings =
        List.map
            (\role ->
                { role = role
                , enabled = role == DRep
                , weightingMode = List.head (allowedWeightings role) |> Maybe.withDefault CredentialBased
                }
            )
            allRoles
    , endEpoch = ""
    , ownerKeyHash = ""
    , timelocked = False
    , revealMinutes = "5"
    , paddingSize = ""
    }


updateForm : FormMsg -> SurveyForm -> SurveyForm
updateForm msg form =
    case msg of
        SetTitle v ->
            { form | title = v }

        SetDescription v ->
            { form | description = v }

        SetEndEpoch v ->
            { form | endEpoch = v }

        SetOwnerKeyHash v ->
            { form | ownerKeyHash = v }

        AddQuestion ->
            { form | questions = form.questions ++ [ emptyQuestion ] }

        RemoveQuestion idx ->
            { form | questions = List.Extra.removeAt idx form.questions }

        SetQuestionType idx typeStr ->
            { form | questions = updateAt idx (setQuestionType typeStr) form.questions }

        SetPrompt idx v ->
            { form | questions = updateAt idx (\q -> { q | prompt = v }) form.questions }

        AddOption idx ->
            { form | questions = updateAt idx (\q -> { q | options = q.options ++ [ "" ] }) form.questions }

        RemoveOption qIdx oIdx ->
            { form
                | questions =
                    updateAt qIdx
                        (\q -> { q | options = List.Extra.removeAt oIdx q.options })
                        form.questions
            }

        SetOption qIdx oIdx v ->
            { form
                | questions =
                    updateAt qIdx
                        (\q -> { q | options = updateAt oIdx (\_ -> v) q.options })
                        form.questions
            }

        SetMaxSelections idx v ->
            { form | questions = updateAt idx (\q -> { q | maxSelections = v }) form.questions }

        SetMaxRanked idx v ->
            { form | questions = updateAt idx (\q -> { q | maxRanked = v }) form.questions }

        SetMinValue idx v ->
            { form | questions = updateAt idx (\q -> { q | minValue = v }) form.questions }

        SetMaxValue idx v ->
            { form | questions = updateAt idx (\q -> { q | maxValue = v }) form.questions }

        SetStep idx v ->
            { form | questions = updateAt idx (\q -> { q | step = v }) form.questions }

        SetSchemaUri idx v ->
            { form | questions = updateAt idx (\q -> { q | schemaUri = v }) form.questions }

        SetSchemaHash idx v ->
            { form | questions = updateAt idx (\q -> { q | schemaHash = v }) form.questions }

        ToggleRole role ->
            { form
                | roleWeightings =
                    List.map
                        (\rw ->
                            if rw.role == role then
                                { rw | enabled = not rw.enabled }

                            else
                                rw
                        )
                        form.roleWeightings
            }

        SetWeighting role wmStr ->
            { form
                | roleWeightings =
                    List.map
                        (\rw ->
                            if rw.role == role then
                                { rw | weightingMode = stringToWeightingMode wmStr }

                            else
                                rw
                        )
                        form.roleWeightings
            }

        SetTimelocked v ->
            { form | timelocked = v }

        SetRevealMinutes v ->
            { form | revealMinutes = v }

        SetPaddingSize v ->
            { form | paddingSize = v }

        SubmitSurvey ->
            form


updateAt : Int -> (a -> a) -> List a -> List a
updateAt idx f list =
    List.indexedMap
        (\i item ->
            if i == idx then
                f item

            else
                item
        )
        list


setQuestionType : String -> QuestionForm -> QuestionForm
setQuestionType typeStr q =
    let
        qt =
            stringToQuestionType typeStr
    in
    { q
        | questionType = qt
        , options =
            if needsOptions qt && List.length q.options < 2 then
                [ "", "" ]

            else
                q.options
    }


needsOptions : QuestionType -> Bool
needsOptions qt =
    case qt of
        SingleChoiceType ->
            True

        MultiSelectType ->
            True

        RankingType ->
            True

        NumericRangeType ->
            False

        CustomType ->
            False


stringToQuestionType : String -> QuestionType
stringToQuestionType s =
    case s of
        "multi-select" ->
            MultiSelectType

        "ranking" ->
            RankingType

        "numeric-range" ->
            NumericRangeType

        "custom" ->
            CustomType

        _ ->
            SingleChoiceType


questionTypeToValue : QuestionType -> String
questionTypeToValue qt =
    case qt of
        SingleChoiceType ->
            "single-choice"

        MultiSelectType ->
            "multi-select"

        RankingType ->
            "ranking"

        NumericRangeType ->
            "numeric-range"

        CustomType ->
            "custom"




-- ============================================================
-- FORM VALIDATION -> SurveyDefinition
-- ============================================================


{-| Best-effort worst-case ballot size for the form's current questions, used to
display the auto padding default. `Nothing` while questions are still invalid.
-}
formMaxPlaintextSize : SurveyForm -> Maybe Int
formMaxPlaintextSize form =
    traverseResults validateQuestion form.questions
        |> Result.map maxPlaintextSize
        |> Result.toMaybe


formToDefinition : Int -> SurveyForm -> Result String SurveyDefinition
formToDefinition nowUnix form =
    let
        validateTitle =
            if String.isEmpty (String.trim form.title) then
                Err "Title is required"

            else
                Ok (String.trim form.title)

        validateDescription =
            Ok (String.trim form.description)

        validateEndEpoch =
            String.toInt form.endEpoch
                |> Result.fromMaybe "End epoch must be a valid integer"

        validateOwner =
            let
                hex =
                    String.trim form.ownerKeyHash
            in
            if String.length hex /= 56 then
                Err "Owner key hash must be 56 hex characters (28 bytes)"

            else
                Ok (VKeyHash (Bytes.fromHexUnchecked hex))

        validateQuestions =
            if List.isEmpty form.questions then
                Err "At least one question is required"

            else
                traverseResults validateQuestion form.questions

        validateRoles =
            let
                enabled =
                    List.filter .enabled form.roleWeightings
            in
            if List.isEmpty enabled then
                Err "At least one role must be enabled"

            else
                Ok (List.map (\rw -> ( rw.role, rw.weightingMode )) enabled)

        validatePositiveInt errMsg s =
            String.toInt s
                |> Result.fromMaybe errMsg
                |> Result.andThen
                    (\n ->
                        if n >= 1 then
                            Ok n

                        else
                            Err errMsg
                    )

        validateBallotMode =
            if form.timelocked then
                let
                    validatePadding =
                        if String.isEmpty (String.trim form.paddingSize) then
                            validateQuestions
                                |> Result.map maxPlaintextSize
                                |> Result.withDefault 0
                                |> Ok

                        else
                            validatePositiveInt "Padding size must be a positive number of bytes" form.paddingSize
                in
                Result.map2
                    (\minutes padding ->
                        let
                            deadline =
                                nowUnix + (minutes * 60)
                        in
                        Timelocked
                            { chainHash = Bytes.fromHexUnchecked quicknetChainHashHex
                            , round = Tlock.roundForDeadline deadline
                            , paddingSize = padding
                            }
                    )
                    (validatePositiveInt "Reveal delay must be a positive number of minutes" form.revealMinutes)
                    validatePadding

            else
                Ok Public

        specVersion =
            3
    in
    Ok SurveyDefinition
        |> resultApply (Ok specVersion)
        |> resultApply validateOwner
        |> resultApply validateTitle
        |> resultApply validateDescription
        |> resultApply validateRoles
        |> resultApply validateEndEpoch
        |> resultApply validateBallotMode
        |> resultApply validateQuestions


validateQuestion : QuestionForm -> Result String SurveyQuestion
validateQuestion q =
    let
        prompt =
            String.trim q.prompt
    in
    if String.isEmpty prompt then
        Err "Question prompt is required"

    else
        case q.questionType of
            SingleChoiceType ->
                validateOptions q.options
                    |> Result.map (\opts -> SingleChoice { prompt = prompt, options = opts })

            MultiSelectType ->
                Result.map2
                    (\opts maxSel ->
                        MultiSelect { prompt = prompt, options = opts, maxSelections = maxSel }
                    )
                    (validateOptions q.options)
                    (String.toInt q.maxSelections
                        |> Result.fromMaybe "Max selections must be a valid integer"
                    )

            RankingType ->
                Result.map2
                    (\opts maxR ->
                        Ranking { prompt = prompt, options = opts, maxRanked = maxR }
                    )
                    (validateOptions q.options)
                    (String.toInt q.maxRanked
                        |> Result.fromMaybe "Max ranked must be a valid integer"
                    )

            NumericRangeType ->
                Result.map2
                    (\minV maxV ->
                        let
                            stepVal =
                                if String.isEmpty (String.trim q.step) then
                                    Nothing

                                else
                                    String.toInt q.step
                        in
                        NumericRange
                            { prompt = prompt
                            , constraints = { minValue = minV, maxValue = maxV, step = stepVal }
                            }
                    )
                    (String.toInt q.minValue
                        |> Result.fromMaybe "Min value must be a valid integer"
                    )
                    (String.toInt q.maxValue
                        |> Result.fromMaybe "Max value must be a valid integer"
                    )

            CustomType ->
                let
                    uri =
                        String.trim q.schemaUri
                in
                if String.isEmpty uri then
                    Err "Schema URI is required for custom questions"

                else
                    let
                        hash =
                            String.trim q.schemaHash
                    in
                    if String.length hash /= 64 then
                        Err "Schema hash must be 64 hex characters (32 bytes)"

                    else
                        Ok (Custom { prompt = prompt, schemaUri = uri, schemaHash = Bytes.fromHexUnchecked hash })


validateOptions : List String -> Result String (List String)
validateOptions options =
    let
        trimmed =
            List.map String.trim options
                |> List.filter (not << String.isEmpty)
    in
    if List.length trimmed < 2 then
        Err "At least 2 non-empty options are required"

    else
        Ok trimmed



-- ============================================================
-- RESPONSE FORM TYPES
-- ============================================================


type AnswerForm
    = SingleChoiceForm (Maybe Int)
    | MultiSelectForm (List Int)
    | RankingForm (List Int)
    | NumericForm String
    | CustomForm String


type alias ResponseForm =
    { role : Maybe Role
    , answers : List AnswerForm
    }


type ResponseFormMsg
    = SetResponseRole String
    | SelectSingleChoice Int Int
    | ToggleMultiSelect Int Int
    | AddToRanking Int Int
    | RemoveFromRanking Int Int
    | SetNumericAnswer Int String
    | SetCustomAnswer Int String
    | SubmitResponse



-- ============================================================
-- RESPONSE FORM LOGIC
-- ============================================================


initResponseForm : SurveyDefinition -> ResponseForm
initResponseForm def =
    { role =
        case def.roleWeighting of
            ( r, _ ) :: _ ->
                Just r

            [] ->
                Nothing
    , answers = List.map initAnswerForm def.questions
    }


initAnswerForm : SurveyQuestion -> AnswerForm
initAnswerForm q =
    case q of
        SingleChoice _ ->
            SingleChoiceForm Nothing

        MultiSelect _ ->
            MultiSelectForm []

        Ranking _ ->
            RankingForm []

        NumericRange { constraints } ->
            NumericForm (String.fromInt constraints.minValue)

        Custom _ ->
            CustomForm ""


updateResponseForm : ResponseFormMsg -> ResponseForm -> ResponseForm
updateResponseForm msg form =
    case msg of
        SetResponseRole roleStr ->
            { form | role = stringToRole roleStr }

        SelectSingleChoice qIdx optIdx ->
            { form
                | answers =
                    updateAt qIdx (\_ -> SingleChoiceForm (Just optIdx)) form.answers
            }

        ToggleMultiSelect qIdx optIdx ->
            { form
                | answers =
                    updateAt qIdx
                        (\a ->
                            case a of
                                MultiSelectForm selected ->
                                    if List.member optIdx selected then
                                        MultiSelectForm (List.filter (\i -> i /= optIdx) selected)

                                    else
                                        MultiSelectForm (selected ++ [ optIdx ])

                                _ ->
                                    a
                        )
                        form.answers
            }

        AddToRanking qIdx optIdx ->
            { form
                | answers =
                    updateAt qIdx
                        (\a ->
                            case a of
                                RankingForm ranked ->
                                    if List.member optIdx ranked then
                                        RankingForm ranked

                                    else
                                        RankingForm (ranked ++ [ optIdx ])

                                _ ->
                                    a
                        )
                        form.answers
            }

        RemoveFromRanking qIdx position ->
            { form
                | answers =
                    updateAt qIdx
                        (\a ->
                            case a of
                                RankingForm ranked ->
                                    RankingForm (List.Extra.removeAt position ranked)

                                _ ->
                                    a
                        )
                        form.answers
            }

        SetNumericAnswer qIdx valStr ->
            { form
                | answers =
                    updateAt qIdx (\_ -> NumericForm valStr) form.answers
            }

        SetCustomAnswer qIdx valStr ->
            { form
                | answers =
                    updateAt qIdx (\_ -> CustomForm valStr) form.answers
            }

        SubmitResponse ->
            form



-- ============================================================
-- RESPONSE ENCODING
-- ============================================================


{-| Build a public (plaintext) response metadatum from a filled form.
-}
buildResponseMetadatum :
    SurveyRef
    -> Credential
    -> ResponseForm
    -> Result String Metadatum
buildResponseMetadatum surveyRef responder form =
    case form.role of
        Nothing ->
            Err "Please select a role"

        Just role ->
            encodeResponseAnswers form
                |> Result.map
                    (\encodedAnswers ->
                        responseEnvelope surveyRef role responder (List encodedAnswers)
                    )


{-| Encode the non-empty answer items from a form (role-independent).
-}
encodeResponseAnswers : ResponseForm -> Result String (List Metadatum)
encodeResponseAnswers form =
    let
        encoded =
            List.indexedMap Tuple.pair form.answers
                |> List.filterMap encodeAnswerForm
    in
    if List.isEmpty encoded then
        Err "Please answer at least one question"

    else
        Ok encoded


encodeAnswerForm : ( Int, AnswerForm ) -> Maybe Metadatum
encodeAnswerForm ( qIdx, answerForm ) =
    case answerForm of
        SingleChoiceForm (Just optIdx) ->
            Just (List [ metaInt 0, metaInt qIdx, metaInt optIdx ])

        SingleChoiceForm Nothing ->
            Nothing

        MultiSelectForm selected ->
            if List.isEmpty selected then
                Nothing

            else
                Just (List [ metaInt 1, metaInt qIdx, List (List.map metaInt selected) ])

        RankingForm ranked ->
            if List.isEmpty ranked then
                Nothing

            else
                Just (List [ metaInt 2, metaInt qIdx, List (List.map metaInt ranked) ])

        NumericForm valStr ->
            case String.toInt valStr of
                Just v ->
                    Just (List [ metaInt 3, metaInt qIdx, metaInt v ])

                Nothing ->
                    Nothing

        CustomForm s ->
            if String.isEmpty (String.trim s) then
                Nothing

            else
                Just (List [ metaInt 4, metaInt qIdx, metaStr s ])
