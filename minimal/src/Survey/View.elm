module Survey.View exposing
    ( metadatumToString
    , viewAnswerItems
    , viewResponseForm
    , viewSurvey
    , viewSurveyForm
    )

import Bytes.Comparable as Bytes
import Cardano.Metadatum as Metadatum
import Html exposing (Html, button, div, h3, input, label, option, p, select, span, text, textarea)
import Html.Attributes as HA
import Html.Events as HE
import Integer
import List.Extra
import Survey.Form exposing (AnswerForm(..), FormMsg(..), QuestionForm, QuestionType(..), ResponseForm, ResponseFormMsg(..), RoleWeightingEntry, SurveyForm, allQuestionTypes, formMaxPlaintextSize, questionTypeToString, questionTypeToValue)
import Survey.Types exposing (AnswerItem(..), NumericConstraints, SurveyDefinition, SurveyQuestion(..), allowedWeightings, credentialToHex, questionOptions, questionPrompt, roleToString, weightingModeToString, weightingModeToValue)
import Tlock



-- ============================================================
-- VIEWS: SURVEY DISPLAY
-- ============================================================


viewSurvey : SurveyDefinition -> Html msg
viewSurvey def =
    div [ HA.class "survey-card" ]
        [ h3 [] [ text def.title ]
        , if not (String.isEmpty def.description) then
            p [ HA.class "survey-desc" ] [ text def.description ]

          else
            text ""
        , p [ HA.class "meta" ]
            [ text ("End epoch: " ++ String.fromInt def.endEpoch)
            , text " | "
            , text ("Version: " ++ String.fromInt def.specVersion)
            ]
        , p [ HA.class "meta" ]
            [ text
                ("Roles: "
                    ++ String.join ", "
                        (List.map
                            (\( r, w ) -> roleToString r ++ " (" ++ weightingModeToString w ++ ")")
                            def.roleWeighting
                        )
                )
            ]
        , p [ HA.class "meta" ]
            [ text ("Owner: " ++ credentialToHex def.owner) ]
        , div [ HA.class "survey-questions" ]
            (List.indexedMap viewQuestionDisplay def.questions)
        ]


viewQuestionDisplay : Int -> SurveyQuestion -> Html msg
viewQuestionDisplay idx question =
    div [ HA.class "question-display" ]
        (case question of
            SingleChoice { prompt, options } ->
                [ questionHeader idx "Single choice" prompt
                , viewOptionsDisplay options
                ]

            MultiSelect { prompt, options, maxSelections } ->
                [ questionHeader idx "Multi-select" prompt
                , p [ HA.class "meta" ] [ text ("Max selections: " ++ String.fromInt maxSelections) ]
                , viewOptionsDisplay options
                ]

            Ranking { prompt, options, maxRanked } ->
                [ questionHeader idx "Ranking" prompt
                , p [ HA.class "meta" ] [ text ("Max ranked: " ++ String.fromInt maxRanked) ]
                , viewOptionsDisplay options
                ]

            NumericRange { prompt, constraints } ->
                [ questionHeader idx "Numeric range" prompt
                , p [ HA.class "meta" ]
                    [ text
                        ("Range: "
                            ++ String.fromInt constraints.minValue
                            ++ " to "
                            ++ String.fromInt constraints.maxValue
                            ++ (case constraints.step of
                                    Just s ->
                                        ", step " ++ String.fromInt s

                                    Nothing ->
                                        ""
                               )
                        )
                    ]
                ]

            Custom { prompt, schemaUri } ->
                [ questionHeader idx "Custom" prompt
                , p [ HA.class "meta" ] [ text ("Schema: " ++ schemaUri) ]
                ]
        )


questionHeader : Int -> String -> String -> Html msg
questionHeader idx typeLabel prompt =
    div []
        [ span [ HA.class "badge" ] [ text typeLabel ]
        , span [ HA.class "meta", HA.style "margin-left" "0.5rem" ]
            [ text ("Q" ++ String.fromInt (idx + 1)) ]
        , p [ HA.style "margin" "0.25rem 0" ] [ text prompt ]
        ]


viewOptionsDisplay : List String -> Html msg
viewOptionsDisplay options =
    div [ HA.class "options-list" ]
        (List.indexedMap
            (\i opt ->
                div [ HA.class "option-item" ]
                    [ span [ HA.class "option-index" ] [ text (String.fromInt i ++ ".") ]
                    , text (" " ++ opt)
                    ]
            )
            options
        )



-- ============================================================
-- VIEWS: SURVEY CREATION FORM
-- ============================================================


viewSurveyForm : Int -> SurveyForm -> Maybe String -> String -> (FormMsg -> msg) -> Html msg
viewSurveyForm nowUnix form validationError submitLabel toMsg =
    div [ HA.class "survey-form" ]
        [ h3 [] [ text "Create Survey" ]
        , div [ HA.class "form-group" ]
            [ label [] [ text "Title" ]
            , input
                [ HA.type_ "text"
                , HA.value form.title
                , HA.placeholder "Survey title"
                , HE.onInput (toMsg << SetTitle)
                ]
                []
            ]
        , div [ HA.class "form-group" ]
            [ label [] [ text "Description" ]
            , textarea
                [ HA.value form.description
                , HA.placeholder "Survey description or rationale"
                , HA.rows 3
                , HE.onInput (toMsg << SetDescription)
                ]
                []
            ]
        , div [ HA.class "form-group" ]
            [ label [] [ text "Questions" ]
            , div [ HA.class "questions-list" ]
                (List.indexedMap (viewQuestionForm toMsg) form.questions
                    ++ [ button
                            [ HA.class "btn btn-secondary"
                            , HE.onClick (toMsg AddQuestion)
                            ]
                            [ text "+ Add question" ]
                       ]
                )
            ]
        , div [ HA.class "form-group" ]
            [ label [] [ text "Eligible roles" ]
            , div [ HA.class "roles-list" ]
                (List.map (viewRoleWeighting toMsg) form.roleWeightings)
            ]
        , div [ HA.class "form-row" ]
            [ div [ HA.class "form-group" ]
                [ label [] [ text "End epoch" ]
                , input
                    [ HA.type_ "number"
                    , HA.value form.endEpoch
                    , HA.placeholder "e.g. 504"
                    , HE.onInput (toMsg << SetEndEpoch)
                    ]
                    []
                ]
            , div [ HA.class "form-group" ]
                [ label [] [ text "Owner credential (key hash, hex)" ]
                , input
                    [ HA.type_ "text"
                    , HA.value form.ownerKeyHash
                    , HA.placeholder "56 hex characters"
                    , HA.style "font-family" "monospace"
                    , HE.onInput (toMsg << SetOwnerKeyHash)
                    ]
                    []
                ]
            ]
        , viewBallotModeForm nowUnix form toMsg
        , case validationError of
            Just err ->
                p [ HA.class "error" ] [ text err ]

            Nothing ->
                text ""
        , button
            [ HA.class "btn btn-primary"
            , HE.onClick (toMsg SubmitSurvey)
            ]
            [ text submitLabel ]
        ]


viewBallotModeForm : Int -> SurveyForm -> (FormMsg -> msg) -> Html msg
viewBallotModeForm nowUnix form toMsg =
    div [ HA.class "form-group" ]
        [ label [ HA.class "role-toggle" ]
            [ input
                [ HA.type_ "checkbox"
                , HA.checked form.timelocked
                , HE.onCheck (toMsg << SetTimelocked)
                ]
                []
            , text " Timelocked ballots (delayed reveal via Drand)"
            ]
        , if form.timelocked then
            div []
                [ p [ HA.class "meta" ]
                    [ text "Answers are encrypted on submission and become decryptable by anyone once the chosen Drand round publishes. This is a delayed reveal, not permanent secrecy." ]
                , div [ HA.class "form-row" ]
                    [ div [ HA.class "form-group" ]
                        [ label [] [ text "Reveal after (minutes from creation)" ]
                        , input
                            [ HA.type_ "number"
                            , HA.value form.revealMinutes
                            , HA.placeholder "e.g. 5"
                            , HE.onInput (toMsg << SetRevealMinutes)
                            ]
                            []
                        ]
                    , div [ HA.class "form-group" ]
                        [ label [] [ text "Padding size (bytes)" ]
                        , input
                            [ HA.type_ "number"
                            , HA.value form.paddingSize
                            , HA.placeholder
                                (case formMaxPlaintextSize form of
                                    Just n ->
                                        "auto: " ++ String.fromInt n

                                    Nothing ->
                                        "auto"
                                )
                            , HE.onInput (toMsg << SetPaddingSize)
                            ]
                            []
                        , p [ HA.class "meta" ]
                            [ text "Leave blank to auto-size to the largest possible ballot, so every ciphertext is the same length." ]
                        ]
                    ]
                , case String.toInt form.revealMinutes of
                    Just minutes ->
                        let
                            round =
                                Tlock.roundForDeadline (nowUnix + (minutes * 60))
                        in
                        p [ HA.class "meta" ]
                            [ text ("Drand quicknet round: " ++ String.fromInt round) ]

                    Nothing ->
                        text ""
                ]

          else
            text ""
        ]


viewQuestionForm : (FormMsg -> msg) -> Int -> QuestionForm -> Html msg
viewQuestionForm toMsg idx q =
    div [ HA.class "question-card" ]
        [ div [ HA.class "question-header" ]
            [ span [ HA.class "badge" ] [ text ("Q" ++ String.fromInt (idx + 1)) ]
            , select
                [ HA.value (questionTypeToValue q.questionType)
                , HE.onInput (toMsg << SetQuestionType idx)
                ]
                (List.map
                    (\qt ->
                        option
                            [ HA.value (questionTypeToValue qt) ]
                            [ text (questionTypeToString qt) ]
                    )
                    allQuestionTypes
                )
            , button
                [ HA.class "btn btn-danger btn-sm"
                , HE.onClick (toMsg (RemoveQuestion idx))
                ]
                [ text "Remove" ]
            ]
        , div [ HA.class "form-group" ]
            [ label [] [ text "Prompt" ]
            , textarea
                [ HA.value q.prompt
                , HA.placeholder "Question prompt"
                , HA.rows 2
                , HE.onInput (toMsg << SetPrompt idx)
                ]
                []
            ]
        , viewQuestionTypeFields toMsg idx q
        ]


viewQuestionTypeFields : (FormMsg -> msg) -> Int -> QuestionForm -> Html msg
viewQuestionTypeFields toMsg idx q =
    case q.questionType of
        SingleChoiceType ->
            viewOptionsEditor toMsg idx q.options

        MultiSelectType ->
            div []
                [ viewOptionsEditor toMsg idx q.options
                , div [ HA.class "form-group" ]
                    [ label [] [ text "Max selections" ]
                    , input
                        [ HA.type_ "number"
                        , HA.value q.maxSelections
                        , HA.min "1"
                        , HE.onInput (toMsg << SetMaxSelections idx)
                        ]
                        []
                    ]
                ]

        RankingType ->
            div []
                [ viewOptionsEditor toMsg idx q.options
                , div [ HA.class "form-group" ]
                    [ label [] [ text "Max ranked" ]
                    , input
                        [ HA.type_ "number"
                        , HA.value q.maxRanked
                        , HA.min "1"
                        , HE.onInput (toMsg << SetMaxRanked idx)
                        ]
                        []
                    ]
                ]

        NumericRangeType ->
            div [ HA.class "form-row" ]
                [ div [ HA.class "form-group" ]
                    [ label [] [ text "Min value" ]
                    , input
                        [ HA.type_ "number"
                        , HA.value q.minValue
                        , HE.onInput (toMsg << SetMinValue idx)
                        ]
                        []
                    ]
                , div [ HA.class "form-group" ]
                    [ label [] [ text "Max value" ]
                    , input
                        [ HA.type_ "number"
                        , HA.value q.maxValue
                        , HE.onInput (toMsg << SetMaxValue idx)
                        ]
                        []
                    ]
                , div [ HA.class "form-group" ]
                    [ label [] [ text "Step (optional)" ]
                    , input
                        [ HA.type_ "number"
                        , HA.value q.step
                        , HA.placeholder "e.g. 5"
                        , HE.onInput (toMsg << SetStep idx)
                        ]
                        []
                    ]
                ]

        CustomType ->
            div []
                [ div [ HA.class "form-group" ]
                    [ label [] [ text "Schema URI" ]
                    , input
                        [ HA.type_ "text"
                        , HA.value q.schemaUri
                        , HA.placeholder "https://..."
                        , HE.onInput (toMsg << SetSchemaUri idx)
                        ]
                        []
                    ]
                , div [ HA.class "form-group" ]
                    [ label [] [ text "Schema hash (blake2b-256, hex)" ]
                    , input
                        [ HA.type_ "text"
                        , HA.value q.schemaHash
                        , HA.placeholder "64 hex characters"
                        , HA.style "font-family" "monospace"
                        , HE.onInput (toMsg << SetSchemaHash idx)
                        ]
                        []
                    ]
                ]


viewOptionsEditor : (FormMsg -> msg) -> Int -> List String -> Html msg
viewOptionsEditor toMsg qIdx options =
    div [ HA.class "form-group" ]
        [ label [] [ text "Options" ]
        , div [ HA.class "options-editor" ]
            (List.indexedMap
                (\oIdx opt ->
                    div [ HA.class "option-row" ]
                        [ span [ HA.class "option-index" ] [ text (String.fromInt oIdx ++ ".") ]
                        , input
                            [ HA.type_ "text"
                            , HA.value opt
                            , HA.placeholder ("Option " ++ String.fromInt oIdx)
                            , HE.onInput (toMsg << SetOption qIdx oIdx)
                            ]
                            []
                        , if List.length options > 2 then
                            button
                                [ HA.class "btn btn-danger btn-sm"
                                , HE.onClick (toMsg (RemoveOption qIdx oIdx))
                                ]
                                [ text "x" ]

                          else
                            text ""
                        ]
                )
                options
                ++ [ button
                        [ HA.class "btn btn-secondary btn-sm"
                        , HE.onClick (toMsg (AddOption qIdx))
                        ]
                        [ text "+ Add option" ]
                   ]
            )
        ]


viewRoleWeighting : (FormMsg -> msg) -> RoleWeightingEntry -> Html msg
viewRoleWeighting toMsg rw =
    div [ HA.class "role-row" ]
        [ label [ HA.class "role-toggle" ]
            [ input
                [ HA.type_ "checkbox"
                , HA.checked rw.enabled
                , HE.onClick (toMsg (ToggleRole rw.role))
                ]
                []
            , text (" " ++ roleToString rw.role)
            ]
        , if rw.enabled then
            select
                [ HA.value (weightingModeToValue rw.weightingMode)
                , HE.onInput (toMsg << SetWeighting rw.role)
                ]
                (List.map
                    (\wm ->
                        option
                            [ HA.value (weightingModeToValue wm) ]
                            [ text (weightingModeToString wm) ]
                    )
                    (allowedWeightings rw.role)
                )

          else
            text ""
        ]



-- ============================================================
-- VIEWS: RESPONSE FORM
-- ============================================================


viewResponseForm : SurveyDefinition -> ResponseForm -> Maybe String -> String -> (ResponseFormMsg -> msg) -> Html msg
viewResponseForm def form validationError submitLabel toMsg =
    div [ HA.class "survey-form" ]
        [ h3 [] [ text "Respond to Survey" ]
        , viewSurvey def
        , div [ HA.class "form-group" ]
            [ label [] [ text "Your role" ]
            , select
                [ HA.value (Maybe.map roleToString form.role |> Maybe.withDefault "")
                , HE.onInput (toMsg << SetResponseRole)
                ]
                (option [ HA.value "" ] [ text "-- Select role --" ]
                    :: List.map
                        (\( r, _ ) ->
                            option [ HA.value (roleToString r) ] [ text (roleToString r) ]
                        )
                        def.roleWeighting
                )
            ]
        , div [ HA.class "survey-questions" ]
            (List.indexedMap
                (\qIdx ( question, answer ) ->
                    viewAnswerInput toMsg qIdx question answer
                )
                (List.map2 Tuple.pair def.questions form.answers)
            )
        , case validationError of
            Just err ->
                p [ HA.class "error" ] [ text err ]

            Nothing ->
                text ""
        , button
            [ HA.class "btn btn-primary"
            , HE.onClick (toMsg SubmitResponse)
            ]
            [ text submitLabel ]
        ]


viewAnswerInput : (ResponseFormMsg -> msg) -> Int -> SurveyQuestion -> AnswerForm -> Html msg
viewAnswerInput toMsg qIdx question answer =
    div [ HA.class "question-card" ]
        (case ( question, answer ) of
            ( SingleChoice { prompt, options }, SingleChoiceForm selected ) ->
                [ questionHeader qIdx "Single choice" prompt
                , viewSingleChoiceInput toMsg qIdx selected options
                ]

            ( MultiSelect { prompt, options, maxSelections }, MultiSelectForm selected ) ->
                [ questionHeader qIdx "Multi-select" prompt
                , p [ HA.class "meta" ] [ text ("Select up to " ++ String.fromInt maxSelections) ]
                , viewMultiSelectInput toMsg qIdx selected options
                ]

            ( Ranking { prompt, options, maxRanked }, RankingForm ranked ) ->
                [ questionHeader qIdx "Ranking" prompt
                , p [ HA.class "meta" ] [ text ("Rank up to " ++ String.fromInt maxRanked) ]
                , viewRankingInput toMsg qIdx ranked options
                ]

            ( NumericRange { prompt, constraints }, NumericForm value ) ->
                [ questionHeader qIdx "Numeric range" prompt
                , p [ HA.class "meta" ]
                    [ text
                        ("Range: "
                            ++ String.fromInt constraints.minValue
                            ++ " to "
                            ++ String.fromInt constraints.maxValue
                            ++ (case constraints.step of
                                    Just s ->
                                        ", step " ++ String.fromInt s

                                    Nothing ->
                                        ""
                               )
                        )
                    ]
                , viewNumericInput toMsg qIdx value constraints
                ]

            ( Custom { prompt }, CustomForm value ) ->
                [ questionHeader qIdx "Custom" prompt
                , textarea
                    [ HA.value value
                    , HA.rows 3
                    , HA.placeholder "Your answer..."
                    , HE.onInput (toMsg << SetCustomAnswer qIdx)
                    ]
                    []
                ]

            _ ->
                [ text "" ]
        )


viewSingleChoiceInput : (ResponseFormMsg -> msg) -> Int -> Maybe Int -> List String -> Html msg
viewSingleChoiceInput toMsg qIdx selected options =
    div []
        (List.indexedMap
            (\oIdx opt ->
                label [ HA.style "display" "block", HA.style "cursor" "pointer" ]
                    [ input
                        [ HA.type_ "radio"
                        , HA.name ("q" ++ String.fromInt qIdx)
                        , HA.checked (selected == Just oIdx)
                        , HE.onClick (toMsg (SelectSingleChoice qIdx oIdx))
                        ]
                        []
                    , text (" " ++ opt)
                    ]
            )
            options
        )


viewMultiSelectInput : (ResponseFormMsg -> msg) -> Int -> List Int -> List String -> Html msg
viewMultiSelectInput toMsg qIdx selected options =
    div []
        (List.indexedMap
            (\oIdx opt ->
                label [ HA.style "display" "block", HA.style "cursor" "pointer" ]
                    [ input
                        [ HA.type_ "checkbox"
                        , HA.checked (List.member oIdx selected)
                        , HE.onClick (toMsg (ToggleMultiSelect qIdx oIdx))
                        ]
                        []
                    , text (" " ++ opt)
                    ]
            )
            options
        )


viewRankingInput : (ResponseFormMsg -> msg) -> Int -> List Int -> List String -> Html msg
viewRankingInput toMsg qIdx ranked options =
    div []
        [ if not (List.isEmpty ranked) then
            div []
                [ p [ HA.class "meta" ] [ text "Current ranking:" ]
                , div []
                    (List.indexedMap
                        (\pos optIdx ->
                            div [ HA.style "display" "flex", HA.style "align-items" "center", HA.style "gap" "0.5rem", HA.style "margin" "0.15rem 0" ]
                                [ span [] [ text (String.fromInt (pos + 1) ++ ". " ++ (List.Extra.getAt optIdx options |> Maybe.withDefault "?")) ]
                                , button
                                    [ HA.class "btn btn-danger btn-sm"
                                    , HE.onClick (toMsg (RemoveFromRanking qIdx pos))
                                    ]
                                    [ text "x" ]
                                ]
                        )
                        ranked
                    )
                ]

          else
            text ""
        , div [ HA.style "margin-top" "0.25rem" ]
            (List.indexedMap
                (\oIdx opt ->
                    if not (List.member oIdx ranked) then
                        button
                            [ HA.class "btn btn-sm"
                            , HA.style "margin" "0.15rem"
                            , HE.onClick (toMsg (AddToRanking qIdx oIdx))
                            ]
                            [ text ("+ " ++ opt) ]

                    else
                        text ""
                )
                options
            )
        ]


viewNumericInput : (ResponseFormMsg -> msg) -> Int -> String -> NumericConstraints -> Html msg
viewNumericInput toMsg qIdx value constraints =
    input
        [ HA.type_ "number"
        , HA.value value
        , HA.min (String.fromInt constraints.minValue)
        , HA.max (String.fromInt constraints.maxValue)
        , case constraints.step of
            Just s ->
                HA.step (String.fromInt s)

            Nothing ->
                HA.class ""
        , HE.onInput (toMsg << SetNumericAnswer qIdx)
        ]
        []



-- ============================================================
-- VIEWS: RESPONSE DISPLAY
-- ============================================================


{-| Render a list of decoded answer items (public answers, or a timelocked
ballot after it has been revealed and decrypted).
-}
viewAnswerItems : Maybe SurveyDefinition -> List AnswerItem -> Html msg
viewAnswerItems maybeDef items =
    div [ HA.class "survey-questions" ]
        (List.map (viewAnswerItemDisplay maybeDef) items)


viewAnswerItemDisplay : Maybe SurveyDefinition -> AnswerItem -> Html msg
viewAnswerItemDisplay maybeDef item =
    let
        getQuestion qIdx =
            maybeDef |> Maybe.andThen (\def -> List.Extra.getAt qIdx def.questions)

        getPrompt qIdx =
            getQuestion qIdx
                |> Maybe.map questionPrompt
                |> Maybe.withDefault ("Question " ++ String.fromInt qIdx)

        getOption qIdx optIdx =
            getQuestion qIdx
                |> Maybe.andThen (questionOptions >> List.Extra.getAt optIdx)
                |> Maybe.withDefault (String.fromInt optIdx)
    in
    case item of
        AnswerSingleChoice qIdx optIdx ->
            div [ HA.class "question-display" ]
                [ p [] [ text (getPrompt qIdx) ]
                , p [ HA.class "meta" ] [ text ("Answer: " ++ getOption qIdx optIdx) ]
                ]

        AnswerMultiSelect qIdx selected ->
            div [ HA.class "question-display" ]
                [ p [] [ text (getPrompt qIdx) ]
                , p [ HA.class "meta" ]
                    [ text ("Selected: " ++ String.join ", " (List.map (getOption qIdx) selected)) ]
                ]

        AnswerRanking qIdx ranked ->
            div [ HA.class "question-display" ]
                [ p [] [ text (getPrompt qIdx) ]
                , div [ HA.class "meta" ]
                    (List.indexedMap
                        (\pos optIdx ->
                            p [] [ text (String.fromInt (pos + 1) ++ ". " ++ getOption qIdx optIdx) ]
                        )
                        ranked
                    )
                ]

        AnswerNumeric qIdx value ->
            div [ HA.class "question-display" ]
                [ p [] [ text (getPrompt qIdx) ]
                , p [ HA.class "meta" ] [ text ("Value: " ++ String.fromInt value) ]
                ]

        AnswerCustom qIdx _ ->
            div [ HA.class "question-display" ]
                [ p [] [ text (getPrompt qIdx) ]
                , p [ HA.class "meta" ] [ text "(Custom answer)" ]
                ]



-- METADATUM PRETTY-PRINTER


metadatumToString : Metadatum.Metadatum -> String
metadatumToString m =
    metadatumToStringHelper 0 m


metadatumToStringHelper : Int -> Metadatum.Metadatum -> String
metadatumToStringHelper indent m =
    let
        pad =
            String.repeat (indent * 2) " "
    in
    case m of
        Metadatum.Int i ->
            String.fromInt (Integer.toInt i)

        Metadatum.String s ->
            "\"" ++ s ++ "\""

        Metadatum.Bytes b ->
            "h'" ++ Bytes.toHex (Bytes.toAny b) ++ "'"

        Metadatum.List items ->
            if List.isEmpty items then
                "[]"

            else
                "[\n"
                    ++ String.join ",\n"
                        (List.map
                            (\item -> pad ++ "  " ++ metadatumToStringHelper (indent + 1) item)
                            items
                        )
                    ++ "\n"
                    ++ pad
                    ++ "]"

        Metadatum.Map pairs ->
            if List.isEmpty pairs then
                "{}"

            else
                "{\n"
                    ++ String.join ",\n"
                        (List.map
                            (\( k, v ) ->
                                pad
                                    ++ "  "
                                    ++ metadatumToStringHelper (indent + 1) k
                                    ++ ": "
                                    ++ metadatumToStringHelper (indent + 1) v
                            )
                            pairs
                        )
                    ++ "\n"
                    ++ pad
                    ++ "}"
