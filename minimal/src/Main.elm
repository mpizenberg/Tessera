port module Main exposing (Flags, Model, Msg, SubmissionStatus, Tab, main)

{-| Minimal Cardano governance app: initializes Cardano-related code
and displays current proposals with their metadata.
Includes CIP-179 survey display and creation.
-}

import Api exposing (ActiveProposal)
import Browser
import Bytes.Comparable as Bytes
import Cardano.Address exposing (Credential(..), NetworkId(..))
import Cardano.Cip30 as Cip30 exposing (WalletDescriptor)
import Cardano.Metadatum as Metadatum
import Cardano.Transaction as Transaction exposing (Transaction)
import Cardano.TxIntent as TxIntent exposing (SpendSource(..), TxIntent(..), TxOtherInfo(..))
import Cardano.Utxo as Utxo exposing (Output)
import Cardano.Value as Value
import ConcurrentTask
import Dict exposing (Dict)
import File.Download
import Html exposing (Html, button, div, h1, h3, nav, p, pre, span, text)
import Html.Attributes as HA
import Html.Events exposing (onClick)
import Http
import Integer
import Json.Decode as JD exposing (Decoder, Value)
import Natural as N
import RemoteData exposing (RemoteData(..), WebData)
import Route
import Survey.Codec as Codec
import Survey.Form as Form
import Survey.Types as ST exposing (BallotState(..), OnchainResponse, OnchainSurvey)
import Survey.View as View
import Task
import Time
import Tlock



-- PORTS


port toWallet : Value -> Cmd msg


port fromWallet : (Value -> msg) -> Sub msg


port sendTask : Value -> Cmd msg


port receiveTask : (Value -> msg) -> Sub msg



-- MODEL


type Tab
    = SurveysTab
    | CreateSurveyTab
    | FillSurveyTab
    | ResponsesTab
    | CancelSurveyTab


type SubmissionStatus
    = NotSubmitting
    | EncryptingBallot
    | WaitingForSignature { tx : Transaction, createdSurvey : Maybe ST.SurveyDefinition }
    | WaitingForSubmission { tx : Transaction, createdSurvey : Maybe ST.SurveyDefinition }
    | Submitted { txId : String, createdSurvey : Maybe ST.SurveyDefinition }
    | SubmissionError String


type alias Flags =
    { url : String
    , db : Value
    , networkId : Int
    }


type alias Model =
    { networkId : NetworkId
    , focus : Route.SurveyFocus
    , db : Value
    , protocolParams : Maybe Api.ProtocolParams
    , epoch : WebData Int
    , proposals : WebData (Dict String ActiveProposal)
    , walletsDiscovered : List WalletDescriptor
    , wallet : Maybe Cip30.Wallet
    , taskPool : ConcurrentTask.Pool Msg
    , errors : List String
    , activeTab : Tab
    , surveyForm : Form.SurveyForm
    , surveyFormError : Maybe String
    , createdSurveys : List ST.SurveyDefinition
    , onchainSurveys : WebData (List OnchainSurvey)
    , onchainResponses : List OnchainResponse
    , onchainCancellations : List ST.SurveyRef
    , surveyTxSlot : Dict String Int
    , walletUtxos : Maybe (Utxo.RefDict Output)
    , submissionStatus : SubmissionStatus
    , responseTarget : Maybe OnchainSurvey
    , responseForm : Form.ResponseForm
    , responseFormError : Maybe String
    , cancelTarget : Maybe OnchainSurvey
    , currentTime : Int
    , decryptedBallots : Dict String BallotState
    }


init : Flags -> ( Model, Cmd Msg )
init flags =
    let
        networkId =
            if flags.networkId == 1 then
                Mainnet

            else
                Testnet

        model =
            { networkId = networkId
            , focus = Route.parseFocus flags.url
            , db = flags.db
            , protocolParams = Nothing
            , epoch = NotAsked
            , proposals = NotAsked
            , walletsDiscovered = []
            , wallet = Nothing
            , taskPool = ConcurrentTask.pool
            , errors = []
            , activeTab = SurveysTab
            , surveyForm = Form.emptyForm
            , surveyFormError = Nothing
            , createdSurveys = []
            , onchainSurveys = NotAsked
            , onchainResponses = []
            , onchainCancellations = []
            , surveyTxSlot = Dict.empty
            , walletUtxos = Nothing
            , submissionStatus = NotSubmitting
            , responseTarget = Nothing
            , responseForm = { role = Nothing, answers = [] }
            , responseFormError = Nothing
            , cancelTarget = Nothing
            , currentTime = 0
            , decryptedBallots = Dict.empty
            }
    in
    ( { model | epoch = Loading }
    , Cmd.batch
        [ Api.loadProtocolParams networkId GotProtocolParams
        , Api.queryEpoch networkId GotEpoch
        , toWallet (Cip30.encodeRequest Cip30.discoverWallets)
        , Task.perform Tick Time.now
        ]
    )



-- MSG


type Msg
    = WalletMsg Value
    | GotProtocolParams (Result Http.Error Api.ProtocolParams)
    | GotEpoch (Result Http.Error Int)
    | ConnectWalletClicked { id : String, supportedExtensions : List Int }
    | DisconnectWalletClicked
    | OnTaskProgress ( ConcurrentTask.Pool Msg, Cmd Msg )
    | TabClicked Tab
    | SurveyFormMsg Form.FormMsg
    | RespondToSurvey OnchainSurvey
    | ResponseFormMsg Form.ResponseFormMsg
    | CancelSurvey OnchainSurvey
    | ConfirmCancelSurvey
    | GotSurveyTxHashes (Result Http.Error (List Api.SurveyTxSlot))
    | GotSurveyMetadata (Result Http.Error (List Api.SurveyTxMetadata))
    | Tick Time.Posix
    | TimelockEncrypted (ConcurrentTask.Response String { ciphertextHex : String })
    | RevealBallot String String
    | BallotDecrypted String (ConcurrentTask.Response String { plaintextHex : String })
    | ExportCsv OnchainSurvey



-- UPDATE


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        GotProtocolParams result ->
            case result of
                Ok params ->
                    ( { model | protocolParams = Just params }, Cmd.none )

                Err _ ->
                    ( { model | errors = "Failed to load protocol params" :: model.errors }, Cmd.none )

        GotEpoch result ->
            case result of
                Err _ ->
                    ( { model | epoch = Failure Http.NetworkError }, Cmd.none )

                Ok epoch ->
                    let
                        form =
                            model.surveyForm

                        prefilledForm =
                            if String.isEmpty form.endEpoch then
                                { form | endEpoch = String.fromInt (epoch + 1) }

                            else
                                form
                    in
                    ( { model | epoch = Success epoch, surveyForm = prefilledForm, proposals = Loading, onchainSurveys = Loading }
                    , Api.loadSurveyTxHashes model.networkId GotSurveyTxHashes
                    )

        WalletMsg value ->
            case JD.decodeValue walletResponseDecoder value of
                Ok response ->
                    handleWalletResponse response model

                Err err ->
                    ( { model | errors = JD.errorToString err :: model.errors }, Cmd.none )

        ConnectWalletClicked { id, supportedExtensions } ->
            ( model
            , toWallet
                (Cip30.encodeRequest
                    (Cip30.enableWallet
                        { id = id
                        , extensions = List.filter (\ext -> ext == 95) supportedExtensions
                        , watchInterval = Nothing
                        }
                    )
                )
            )

        DisconnectWalletClicked ->
            ( { model | wallet = Nothing, walletUtxos = Nothing, submissionStatus = NotSubmitting }, Cmd.none )

        OnTaskProgress ( taskPool, cmd ) ->
            ( { model | taskPool = taskPool }, cmd )

        Tick posix ->
            ( { model | currentTime = Time.posixToMillis posix // 1000 }, Cmd.none )

        TimelockEncrypted response ->
            case response of
                ConcurrentTask.Success { ciphertextHex } ->
                    case ( model.responseTarget, model.responseForm.role, model.wallet ) of
                        ( Just target, Just role, Just wallet ) ->
                            case Cardano.Address.extractPaymentCred (Cip30.walletChangeAddress wallet) of
                                Just cred ->
                                    buildSignResponseTx model
                                        (Codec.buildTimelockedResponseMetadatum
                                            { txHash = target.txHash, index = target.index }
                                            role
                                            cred
                                            (Bytes.fromHexUnchecked ciphertextHex)
                                        )

                                Nothing ->
                                    ( { model
                                        | submissionStatus = SubmissionError "Could not extract wallet credential"
                                        , responseFormError = Just "Could not extract wallet credential"
                                      }
                                    , Cmd.none
                                    )

                        _ ->
                            ( { model | submissionStatus = NotSubmitting }, Cmd.none )

                ConcurrentTask.Error err ->
                    ( { model
                        | submissionStatus = SubmissionError ("Ballot encryption failed: " ++ err)
                        , responseFormError = Just ("Ballot encryption failed: " ++ err)
                      }
                    , Cmd.none
                    )

                ConcurrentTask.UnexpectedError _ ->
                    ( { model
                        | submissionStatus = SubmissionError "Unexpected error during ballot encryption"
                        , responseFormError = Just "Unexpected error during ballot encryption"
                      }
                    , Cmd.none
                    )

        RevealBallot key ciphertextHex ->
            let
                ( newPool, cmd ) =
                    ConcurrentTask.attempt
                        { pool = model.taskPool
                        , send = sendTask
                        , onComplete = BallotDecrypted key
                        }
                        (Tlock.decrypt { ciphertextHex = ciphertextHex })
            in
            ( { model
                | taskPool = newPool
                , decryptedBallots = Dict.insert key Decrypting model.decryptedBallots
              }
            , cmd
            )

        BallotDecrypted key response ->
            let
                state =
                    case response of
                        ConcurrentTask.Success { plaintextHex } ->
                            case Codec.decodeAnswersFromPlaintextHex plaintextHex of
                                Ok items ->
                                    Decrypted items

                                Err err ->
                                    DecryptError err

                        ConcurrentTask.Error err ->
                            DecryptError ("Decryption failed: " ++ err)

                        ConcurrentTask.UnexpectedError _ ->
                            DecryptError "Unexpected error during decryption"
            in
            ( { model | decryptedBallots = Dict.insert key state model.decryptedBallots }, Cmd.none )

        ExportCsv survey ->
            let
                deduped =
                    dedupLatestResponses model.surveyTxSlot (responsesForSurvey survey model.onchainResponses)

                filename =
                    "survey-" ++ survey.txHash ++ "-" ++ String.fromInt survey.index ++ ".csv"
            in
            ( model, File.Download.string filename "text/csv" (buildCsv model survey deduped) )

        TabClicked tab ->
            ( { model | activeTab = tab }, Cmd.none )

        SurveyFormMsg formMsg ->
            case formMsg of
                Form.SubmitSurvey ->
                    submitSurvey model

                _ ->
                    ( { model
                        | surveyForm = Form.updateForm formMsg model.surveyForm
                        , submissionStatus =
                            case model.submissionStatus of
                                SubmissionError _ ->
                                    NotSubmitting

                                _ ->
                                    model.submissionStatus
                      }
                    , Cmd.none
                    )

        RespondToSurvey survey ->
            ( { model
                | responseTarget = Just survey
                , responseForm = Form.initResponseForm survey.definition
                , responseFormError = Nothing
                , submissionStatus = NotSubmitting
                , activeTab = FillSurveyTab
                , cancelTarget = Nothing
              }
            , Cmd.none
            )

        CancelSurvey survey ->
            ( { model
                | cancelTarget = Just survey
                , submissionStatus = NotSubmitting
                , activeTab = CancelSurveyTab
                , responseTarget = Nothing
              }
            , Cmd.none
            )

        ConfirmCancelSurvey ->
            submitCancellation model

        ResponseFormMsg formMsg ->
            case formMsg of
                Form.SubmitResponse ->
                    submitResponse model

                _ ->
                    ( { model
                        | responseForm = Form.updateResponseForm formMsg model.responseForm
                        , responseFormError = Nothing
                      }
                    , Cmd.none
                    )

        GotSurveyTxHashes result ->
            case result of
                Err err ->
                    ( { model | onchainSurveys = Failure err }, Cmd.none )

                Ok txSlots ->
                    let
                        -- Keep each tx's absolute slot to resolve "latest response"
                        -- deterministically, independent of /tx_metadata's row order.
                        txSlot =
                            List.map (\r -> ( r.txHash, r.absoluteSlot )) txSlots |> Dict.fromList

                        txHashes =
                            List.map .txHash txSlots
                    in
                    if List.isEmpty txHashes then
                        ( { model | onchainSurveys = Success [], surveyTxSlot = txSlot }, Cmd.none )

                    else
                        ( { model | surveyTxSlot = txSlot }, Api.loadSurveyMetadata model.networkId txHashes GotSurveyMetadata )

        GotSurveyMetadata result ->
            case result of
                Err err ->
                    ( { model | onchainSurveys = Failure err }, Cmd.none )

                Ok txMetaList ->
                    let
                        parsed =
                            List.filterMap
                                (\txMeta ->
                                    case Codec.fromMetadatum txMeta.metadatum of
                                        Ok payload ->
                                            Just ( txMeta, payload )

                                        Err _ ->
                                            Nothing
                                )
                                txMetaList

                        surveys =
                            List.concatMap
                                (\( txMeta, payload ) ->
                                    case payload of
                                        ST.ParsedDefinitions defs ->
                                            List.indexedMap
                                                (\i def ->
                                                    { txHash = txMeta.txHash
                                                    , index = i
                                                    , definition = def
                                                    }
                                                )
                                                defs

                                        _ ->
                                            []
                                )
                                parsed

                        responses =
                            List.concatMap
                                (\( txMeta, payload ) ->
                                    case payload of
                                        ST.ParsedResponses resps ->
                                            List.indexedMap
                                                (\i r -> { txHash = txMeta.txHash, ballotIndex = i, response = r })
                                                resps

                                        _ ->
                                            []
                                )
                                parsed

                        cancellations =
                            List.concatMap
                                (\( _, payload ) ->
                                    case payload of
                                        ST.ParsedCancellations refs ->
                                            refs

                                        _ ->
                                            []
                                )
                                parsed

                        -- In kiosk mode, prime the response form for the focused survey
                        -- so it can be filled inline without a "Respond" click.
                        ( focusTarget, focusForm ) =
                            case ( model.focus, model.responseTarget ) of
                                ( Route.Focus ref, Nothing ) ->
                                    case List.head (List.filter (\s -> s.txHash == ref.txHash && s.index == ref.index) surveys) of
                                        Just survey ->
                                            ( Just survey, Form.initResponseForm survey.definition )

                                        Nothing ->
                                            ( model.responseTarget, model.responseForm )

                                _ ->
                                    ( model.responseTarget, model.responseForm )
                    in
                    ( { model
                        | onchainSurveys = Success surveys
                        , onchainResponses = responses
                        , onchainCancellations = cancellations
                        , responseTarget = focusTarget
                        , responseForm = focusForm
                      }
                    , Cmd.none
                    )


submitSurvey : Model -> ( Model, Cmd Msg )
submitSurvey model =
    case Form.formToDefinition model.currentTime model.surveyForm of
        Err err ->
            ( { model | surveyFormError = Just err }, Cmd.none )

        Ok def ->
            case ( model.wallet, model.walletUtxos ) of
                ( Nothing, _ ) ->
                    ( { model | surveyFormError = Just "Please connect a wallet first" }, Cmd.none )

                ( _, Nothing ) ->
                    ( { model | surveyFormError = Just "Wallet UTxOs not loaded yet" }, Cmd.none )

                ( Just wallet, Just utxos ) ->
                    let
                        changeAddr =
                            Cip30.walletChangeAddress wallet

                        surveyMetadatum =
                            Codec.toMetadatum def

                        -- CIP-179: owner key hash must be in required_signers
                        requiredSignerInfo =
                            case def.owner of
                                VKeyHash hash ->
                                    [ TxRequiredSigner hash ]

                                ScriptHash _ ->
                                    []

                        txResult =
                            TxIntent.finalize utxos
                                (TxMetadata { tag = N.fromSafeInt ST.metadataLabel, metadata = surveyMetadatum }
                                    :: requiredSignerInfo
                                )
                                [ Spend (FromWallet { address = changeAddr, value = Value.onlyLovelace N.zero, guaranteedUtxos = [] }) ]
                    in
                    case txResult of
                        Err err ->
                            ( { model | surveyFormError = Just (TxIntent.errorToString err) }, Cmd.none )

                        Ok { tx } ->
                            ( { model
                                | submissionStatus = WaitingForSignature { tx = tx, createdSurvey = Just def }
                                , surveyFormError = Nothing
                              }
                            , toWallet (Cip30.encodeRequest (Cip30.signTx wallet { partialSign = False } tx))
                            )


walletResponseDecoder : Decoder (Cip30.Response Cip30.ApiResponse)
walletResponseDecoder =
    Cip30.responseDecoder
        (Dict.fromList [ ( 30, Cip30.apiDecoder ) ])


handleWalletResponse : Cip30.Response Cip30.ApiResponse -> Model -> ( Model, Cmd Msg )
handleWalletResponse response model =
    case response of
        Cip30.AvailableWallets wallets ->
            ( { model | walletsDiscovered = wallets }, Cmd.none )

        Cip30.EnabledWallet wallet ->
            ( { model | wallet = Just wallet }
            , toWallet
                (Cip30.encodeRequest
                    (Cip30.getUtxos wallet { amount = Nothing, paginate = Nothing })
                )
            )

        Cip30.ApiResponse _ apiResponse ->
            handleApiResponse apiResponse model

        Cip30.ApiError { info } ->
            let
                submissionUpdate =
                    case model.submissionStatus of
                        WaitingForSignature _ ->
                            SubmissionError ("Wallet error: " ++ info)

                        WaitingForSubmission _ ->
                            SubmissionError ("Submission error: " ++ info)

                        other ->
                            other
            in
            ( { model
                | errors = info :: model.errors
                , submissionStatus = submissionUpdate
              }
            , Cmd.none
            )

        Cip30.UnhandledResponseType err ->
            ( { model | errors = err :: model.errors }, Cmd.none )


handleApiResponse : Cip30.ApiResponse -> Model -> ( Model, Cmd Msg )
handleApiResponse apiResponse model =
    case apiResponse of
        Cip30.WalletUtxos utxos ->
            ( { model | walletUtxos = Just (Utxo.refDictFromList utxos) }, Cmd.none )

        Cip30.ChangeAddress addr ->
            ( { model | wallet = Maybe.map (Cip30.updateChangeAddress addr) model.wallet }, Cmd.none )

        Cip30.SignedTx vkeyWitnesses ->
            case model.submissionStatus of
                WaitingForSignature { tx, createdSurvey } ->
                    case model.wallet of
                        Just wallet ->
                            let
                                signedTx =
                                    Transaction.updateSignatures (\_ -> Just vkeyWitnesses) tx
                            in
                            ( { model | submissionStatus = WaitingForSubmission { tx = signedTx, createdSurvey = createdSurvey } }
                            , toWallet (Cip30.encodeRequest (Cip30.submitTx wallet signedTx))
                            )

                        Nothing ->
                            ( { model | submissionStatus = SubmissionError "Wallet disconnected" }, Cmd.none )

                _ ->
                    ( model, Cmd.none )

        Cip30.SubmittedTx txId ->
            case model.submissionStatus of
                WaitingForSubmission { createdSurvey } ->
                    let
                        newCancellations =
                            case model.cancelTarget of
                                Just target ->
                                    { txHash = target.txHash, index = target.index } :: model.onchainCancellations

                                Nothing ->
                                    model.onchainCancellations
                    in
                    ( { model
                        | submissionStatus = Submitted { txId = Bytes.toHex txId, createdSurvey = createdSurvey }
                        , createdSurveys =
                            case createdSurvey of
                                Just s ->
                                    s :: model.createdSurveys

                                Nothing ->
                                    model.createdSurveys
                        , surveyForm =
                            case createdSurvey of
                                Just _ ->
                                    Form.emptyForm

                                Nothing ->
                                    model.surveyForm
                        , surveyFormError = Nothing
                        , responseFormError = Nothing
                        , cancelTarget = Nothing
                        , onchainCancellations = newCancellations
                        , activeTab = SurveysTab
                      }
                    , Cmd.none
                    )

                _ ->
                    ( model, Cmd.none )

        _ ->
            ( model, Cmd.none )



-- SUBSCRIPTIONS


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.batch
        [ fromWallet WalletMsg
        , Time.every 1000 Tick
        , ConcurrentTask.onProgress
            { send = sendTask
            , receive = receiveTask
            , onProgress = OnTaskProgress
            }
            model.taskPool
        ]



-- VIEW


view : Model -> Html Msg
view model =
    div []
        [ h1 [] [ text "Cardano Governance" ]
        , viewNetworkInfo model.networkId
        , viewWalletBar model
        , viewStatus model
        , case model.focus of
            Route.NoFocus ->
                viewTabbedApp model

            Route.InvalidFocus msg ->
                viewInvalidLink msg

            Route.Focus ref ->
                viewKiosk model ref
        , viewErrors model.errors
        ]


viewTabbedApp : Model -> Html Msg
viewTabbedApp model =
    div []
        [ viewTabs model.activeTab
        , case model.activeTab of
            SurveysTab ->
                viewSurveysTab model

            CreateSurveyTab ->
                viewCreateSurveyTab model

            FillSurveyTab ->
                viewFillSurveyTab model

            ResponsesTab ->
                viewResponsesTab model

            CancelSurveyTab ->
                viewCancelSurveyTab model
        ]


viewInvalidLink : String -> Html Msg
viewInvalidLink msg =
    div [ HA.class "error" ]
        [ h3 [] [ text "Invalid survey link" ]
        , p [] [ text msg ]
        ]


{-| Single-survey ("kiosk") page: resolves the focused ref against the loaded
on-chain surveys and renders that one survey. Fill form, responses, and stats are
layered on in later steps.
-}
viewKiosk : Model -> ST.SurveyRef -> Html Msg
viewKiosk model ref =
    case model.onchainSurveys of
        NotAsked ->
            p [ HA.class "loading" ] [ text "Loading survey..." ]

        Loading ->
            p [ HA.class "loading" ] [ text "Loading survey..." ]

        Failure _ ->
            p [ HA.class "error" ] [ text "Failed to load surveys from chain." ]

        Success surveys ->
            case List.head (List.filter (\s -> s.txHash == ref.txHash && s.index == ref.index) surveys) of
                Nothing ->
                    div [ HA.class "error" ]
                        [ h3 [] [ text "Survey not found" ]
                        , p [] [ text ("No on-chain survey matches " ++ ref.txHash ++ " [" ++ String.fromInt ref.index ++ "].") ]
                        ]

                Just survey ->
                    viewKioskSurvey model survey


viewKioskSurvey : Model -> OnchainSurvey -> Html Msg
viewKioskSurvey model survey =
    let
        isCancelled =
            List.any (\ref -> ref.txHash == survey.txHash && ref.index == survey.index)
                model.onchainCancellations

        deduped =
            dedupLatestResponses model.surveyTxSlot (responsesForSurvey survey model.onchainResponses)
    in
    div []
        [ if isCancelled then
            div [ HA.class "error", HA.style "margin-bottom" "1rem" ]
                [ span [ HA.class "badge", HA.style "background" "#fee2e2", HA.style "color" "#b91c1c" ] [ text "Cancelled" ]
                , span [ HA.style "margin-left" "0.5rem" ] [ text "This survey has been cancelled by its owner." ]
                ]

          else
            text ""
        , p [ HA.class "meta" ]
            [ text ("Tx: " ++ survey.txHash ++ " [" ++ String.fromInt survey.index ++ "]") ]
        , if isCancelled then
            text ""

          else
            viewKioskStats model survey deduped
        , if isCancelled then
            -- No response form when cancelled, so show the definition on its own.
            View.viewSurvey survey.definition

          else
            let
                -- Open while current epoch is at or before endEpoch (inclusive cutoff).
                -- If the epoch hasn't loaded, don't block responding; on-chain rules apply.
                isOpen =
                    case RemoteData.toMaybe model.epoch of
                        Just currentEpoch ->
                            currentEpoch <= survey.definition.endEpoch

                        Nothing ->
                            True
            in
            if isOpen then
                div []
                    [ View.viewResponseForm
                        survey.definition
                        model.responseForm
                        model.responseFormError
                        (submitButtonLabel "Connect wallet to respond" "Submit Response On-Chain" model)
                        ResponseFormMsg
                    , viewSubmissionStatus model.submissionStatus
                    ]

            else
                div []
                    [ View.viewSurvey survey.definition
                    , p [ HA.class "meta" ] [ text "This survey is closed; responses are no longer accepted." ]
                    ]
        , if isCancelled then
            text ""

          else
            viewKioskResults model survey deduped
        , if isCancelled then
            text ""

          else
            viewKioskResponses model survey deduped
        ]


{-| Statistics panel for the focused survey. Raw, unweighted counts over the
deduplicated valid responses (latest per (role, credential)).
-}
viewKioskStats : Model -> OnchainSurvey -> List OnchainResponse -> Html Msg
viewKioskStats model survey deduped =
    div [ HA.class "survey-card", HA.style "margin-top" "1rem" ]
        [ h3 [] [ text "Statistics" ]
        , viewStatusLine model survey
        , p [ HA.class "meta" ]
            [ text (String.fromInt (List.length deduped) ++ " unique participant(s)") ]
        , viewParticipationByRole deduped
        , viewRevealProgress model survey deduped
        , p [ HA.class "meta", HA.style "font-style" "italic" ]
            [ text "Raw counts — not the official weighted CIP-179 tally." ]
        ]


{-| Timelocked-only reveal stats: the Drand round, whether it has unlocked, and
how many of the (deduplicated) ballots are revealed vs awaiting reveal. Renders
nothing for public surveys.
-}
viewRevealProgress : Model -> OnchainSurvey -> List OnchainResponse -> Html Msg
viewRevealProgress model survey deduped =
    case survey.definition.ballotMode of
        ST.Public ->
            text ""

        ST.Timelocked cfg ->
            let
                revealTime =
                    Tlock.revealTimeOf cfg.round

                isUnlocked =
                    model.currentTime >= revealTime

                total =
                    List.length deduped

                revealedCount =
                    List.length
                        (List.filter
                            (\r ->
                                case Dict.get (ballotKey r) model.decryptedBallots of
                                    Just (Decrypted _) ->
                                        True

                                    _ ->
                                        False
                            )
                            deduped
                        )

                pending =
                    total - revealedCount
            in
            div [ HA.style "margin-top" "0.5rem" ]
                [ p [ HA.class "meta" ]
                    [ text ("Ballot mode: timelocked (Drand round " ++ String.fromInt cfg.round ++ ")") ]
                , if isUnlocked then
                    p [ HA.class "meta" ] [ text "Reveal round reached — ballots can be decrypted now." ]

                  else
                    p [ HA.class "meta" ]
                        [ text ("Locked — reveal in ~" ++ String.fromInt (Basics.max 0 (revealTime - model.currentTime)) ++ "s.") ]
                , p [ HA.class "meta" ]
                    [ text ("  Revealed: " ++ String.fromInt revealedCount ++ " / " ++ String.fromInt total) ]
                , p [ HA.class "meta" ]
                    [ text
                        ((if isUnlocked then
                            "  Decryptable now: "

                          else
                            "  Locked (awaiting reveal round): "
                         )
                            ++ String.fromInt pending
                        )
                    ]
                ]


{-| Per-question results over the deduplicated responses. Only choice questions
(single + multi) are aggregated; ranking/numeric/custom show a note. Timelocked
answers are included only once revealed (decrypted in this session).
-}
viewKioskResults : Model -> OnchainSurvey -> List OnchainResponse -> Html Msg
viewKioskResults model survey deduped =
    let
        items =
            List.concatMap (answerItemsOf model) deduped
    in
    div [ HA.class "survey-card", HA.style "margin-top" "1rem" ]
        [ div [ HA.style "display" "flex", HA.style "justify-content" "space-between", HA.style "align-items" "center" ]
            [ h3 [] [ text "Results" ]
            , if List.isEmpty deduped then
                text ""

              else
                button
                    [ HA.class "btn btn-secondary"
                    , onClick (ExportCsv survey)
                    ]
                    [ text "Export CSV" ]
            ]
        , div [] (List.indexedMap (viewQuestionResult items) survey.definition.questions)
        ]


{-| The flat answer items for one response: public answers directly, or a
revealed (decrypted) timelocked ballot. `Nothing` means a timelocked ballot that
is not yet revealed (distinct from "answered nothing").
-}
revealedItems : Model -> OnchainResponse -> Maybe (List ST.AnswerItem)
revealedItems model resp =
    case resp.response.answers of
        ST.PublicAnswers answerItems ->
            Just answerItems

        ST.TimelockedAnswers _ ->
            case Dict.get (ballotKey resp) model.decryptedBallots of
                Just (Decrypted answerItems) ->
                    Just answerItems

                _ ->
                    Nothing


answerItemsOf : Model -> OnchainResponse -> List ST.AnswerItem
answerItemsOf model resp =
    revealedItems model resp |> Maybe.withDefault []



-- CSV EXPORT


{-| One row per (deduplicated) response: responder, role, then one cell per
question. Choice answers use option labels; ranking uses "a > b > c"; numeric the
value; custom a compact text/hex. Not-yet-revealed timelocked ballots export
"encrypted" for every question cell.
-}
buildCsv : Model -> OnchainSurvey -> List OnchainResponse -> String
buildCsv model survey deduped =
    let
        questions =
            survey.definition.questions

        header =
            "responder" :: "role" :: List.map questionPromptOf questions

        row resp =
            ST.credentialToHex resp.response.responder
                :: ST.roleToString resp.response.role
                :: answerCells model questions resp
    in
    String.join "\u{000D}\n" (csvRow header :: List.map (row >> csvRow) deduped)


answerCells : Model -> List ST.SurveyQuestion -> OnchainResponse -> List String
answerCells model questions resp =
    case revealedItems model resp of
        Just items ->
            List.indexedMap (\qIdx q -> cellValue q (findAnswer qIdx items)) questions

        Nothing ->
            List.map (\_ -> "encrypted") questions


findAnswer : Int -> List ST.AnswerItem -> Maybe ST.AnswerItem
findAnswer qIdx items =
    List.head (List.filter (\it -> answerQuestionIndex it == qIdx) items)


answerQuestionIndex : ST.AnswerItem -> Int
answerQuestionIndex item =
    case item of
        ST.AnswerSingleChoice q _ ->
            q

        ST.AnswerMultiSelect q _ ->
            q

        ST.AnswerRanking q _ ->
            q

        ST.AnswerNumeric q _ ->
            q

        ST.AnswerCustom q _ ->
            q


cellValue : ST.SurveyQuestion -> Maybe ST.AnswerItem -> String
cellValue question maybeItem =
    case maybeItem of
        Nothing ->
            ""

        Just (ST.AnswerSingleChoice _ o) ->
            optionLabel question o

        Just (ST.AnswerMultiSelect _ os) ->
            String.join "; " (List.map (optionLabel question) os)

        Just (ST.AnswerRanking _ os) ->
            String.join " > " (List.map (optionLabel question) os)

        Just (ST.AnswerNumeric _ v) ->
            String.fromInt v

        Just (ST.AnswerCustom _ meta) ->
            customCellValue meta


optionLabel : ST.SurveyQuestion -> Int -> String
optionLabel question optIdx =
    let
        options =
            case question of
                ST.SingleChoice r ->
                    r.options

                ST.MultiSelect r ->
                    r.options

                ST.Ranking r ->
                    r.options

                _ ->
                    []
    in
    List.head (List.drop optIdx options) |> Maybe.withDefault (String.fromInt optIdx)


questionPromptOf : ST.SurveyQuestion -> String
questionPromptOf question =
    case question of
        ST.SingleChoice r ->
            r.prompt

        ST.MultiSelect r ->
            r.prompt

        ST.Ranking r ->
            r.prompt

        ST.NumericRange r ->
            r.prompt

        ST.Custom r ->
            r.prompt


customCellValue : Metadatum.Metadatum -> String
customCellValue meta =
    case meta of
        Metadatum.String s ->
            s

        Metadatum.Bytes b ->
            "0x" ++ Bytes.toHex (Bytes.toAny b)

        Metadatum.Int i ->
            String.fromInt (Integer.toInt i)

        _ ->
            "(custom)"


csvRow : List String -> String
csvRow fields =
    String.join "," (List.map csvField fields)


csvField : String -> String
csvField s =
    if String.contains "," s || String.contains "\"" s || String.contains "\n" s || String.contains "\u{000D}" s then
        "\"" ++ String.replace "\"" "\"\"" s ++ "\""

    else
        s


viewQuestionResult : List ST.AnswerItem -> Int -> ST.SurveyQuestion -> Html Msg
viewQuestionResult items qIdx question =
    case question of
        ST.SingleChoice { prompt, options } ->
            viewChoiceTally prompt options (singleChoiceCounts qIdx options items)

        ST.MultiSelect { prompt, options } ->
            viewChoiceTally prompt options (multiSelectCounts qIdx options items)

        ST.Ranking { prompt } ->
            viewNoAggregation prompt "Ranking"

        ST.NumericRange { prompt } ->
            viewNoAggregation prompt "Numeric"

        ST.Custom { prompt } ->
            viewNoAggregation prompt "Custom"


singleChoiceCounts : Int -> List String -> List ST.AnswerItem -> List Int
singleChoiceCounts qIdx options items =
    let
        selected =
            List.filterMap
                (\it ->
                    case it of
                        ST.AnswerSingleChoice q o ->
                            if q == qIdx then
                                Just o

                            else
                                Nothing

                        _ ->
                            Nothing
                )
                items
    in
    List.indexedMap (\optIdx _ -> List.length (List.filter ((==) optIdx) selected)) options


multiSelectCounts : Int -> List String -> List ST.AnswerItem -> List Int
multiSelectCounts qIdx options items =
    let
        selected =
            List.concatMap
                (\it ->
                    case it of
                        ST.AnswerMultiSelect q os ->
                            if q == qIdx then
                                os

                            else
                                []

                        _ ->
                            []
                )
                items
    in
    List.indexedMap (\optIdx _ -> List.length (List.filter ((==) optIdx) selected)) options


viewChoiceTally : String -> List String -> List Int -> Html Msg
viewChoiceTally prompt options counts =
    let
        total =
            List.sum counts

        pct c =
            if total == 0 then
                0

            else
                round (100 * toFloat c / toFloat total)
    in
    div [ HA.style "margin-bottom" "0.75rem" ]
        [ p [] [ text prompt ]
        , if total == 0 then
            p [ HA.class "meta" ] [ text "No answers yet." ]

          else
            div []
                (List.map2
                    (\opt c ->
                        p [ HA.class "meta" ]
                            [ text ("  " ++ opt ++ ": " ++ String.fromInt c ++ " (" ++ String.fromInt (pct c) ++ "%)") ]
                    )
                    options
                    counts
                )
        ]


viewNoAggregation : String -> String -> Html Msg
viewNoAggregation prompt label =
    div [ HA.style "margin-bottom" "0.75rem" ]
        [ p [] [ text prompt ]
        , p [ HA.class "meta", HA.style "font-style" "italic" ]
            [ text ("(" ++ label ++ " — no aggregation in this demo)") ]
        ]


viewStatusLine : Model -> OnchainSurvey -> Html Msg
viewStatusLine model survey =
    case RemoteData.toMaybe model.epoch of
        Nothing ->
            p [ HA.class "meta" ] [ text "Status: unknown (epoch not loaded)" ]

        Just currentEpoch ->
            let
                endEpoch =
                    survey.definition.endEpoch
            in
            if currentEpoch <= endEpoch then
                p [ HA.class "meta" ]
                    [ text
                        ("Status: Open — ends at epoch "
                            ++ String.fromInt endEpoch
                            ++ " ("
                            ++ String.fromInt (endEpoch - currentEpoch)
                            ++ " epoch(s) remaining)"
                        )
                    ]

            else
                p [ HA.class "meta" ]
                    [ text ("Status: Closed — ended at epoch " ++ String.fromInt endEpoch) ]


viewParticipationByRole : List OnchainResponse -> Html Msg
viewParticipationByRole responses =
    let
        counts =
            List.foldl
                (\r acc ->
                    Dict.update (ST.roleToString r.response.role)
                        (\m -> Just (1 + Maybe.withDefault 0 m))
                        acc
                )
                Dict.empty
                responses
                |> Dict.toList
    in
    if List.isEmpty counts then
        text ""

    else
        div []
            (List.map
                (\( role, n ) -> p [ HA.class "meta" ] [ text ("  " ++ role ++ ": " ++ String.fromInt n) ])
                counts
            )


responsesForSurvey : OnchainSurvey -> List OnchainResponse -> List OnchainResponse
responsesForSurvey survey responses =
    List.filter
        (\r -> r.response.surveyRef.txHash == survey.txHash && r.response.surveyRef.index == survey.index)
        responses


{-| Keep the latest response per identity tuple `(role, credential)` for one
survey. Order-independent: latest is resolved from each tx's `absolute_slot`,
tie-broken by `ballotIndex` (responseIndex). This does not depend on the
unspecified row order of the `/tx_metadata` response. The spec's full chain order
is `(slot, txIndexInBlock, responseIndex)`; we don't fetch `txIndexInBlock`, so
two responses in the same slot from different txs are only tie-broken weakly.
-}
dedupLatestResponses : Dict String Int -> List OnchainResponse -> List OnchainResponse
dedupLatestResponses txSlot responses =
    let
        key r =
            ST.roleToString r.response.role ++ "|" ++ ST.credentialToHex r.response.responder

        -- Larger tuple = more recent: higher absolute slot, then higher ballotIndex.
        recency r =
            ( Dict.get r.txHash txSlot |> Maybe.withDefault 0, r.ballotIndex )
    in
    List.foldl
        (\r acc ->
            Dict.update (key r)
                (\existing ->
                    case existing of
                        Just e ->
                            if recency r > recency e then
                                Just r

                            else
                                Just e

                        Nothing ->
                            Just r
                )
                acc
        )
        Dict.empty
        responses
        |> Dict.values


viewKioskResponses : Model -> OnchainSurvey -> List OnchainResponse -> Html Msg
viewKioskResponses model survey deduped =
    div [ HA.style "margin-top" "2rem" ]
        [ h3 [] [ text "Responses" ]
        , if List.isEmpty deduped then
            p [ HA.class "meta" ] [ text "No responses on-chain yet." ]

          else
            div []
                [ p [ HA.class "meta" ]
                    [ text (String.fromInt (List.length deduped) ++ " response(s)") ]
                , div [] (List.map (viewResponse model (Just survey.definition)) deduped)
                ]
        ]


viewTabs : Tab -> Html Msg
viewTabs activeTab =
    nav [ HA.class "tabs" ]
        -- Disable proposals tab temporarily
        -- [ tabButton ProposalsTab "Proposals" activeTab
        [ tabButton SurveysTab "Surveys" activeTab
        , tabButton ResponsesTab "Responses" activeTab
        , tabButton CreateSurveyTab "Create Survey" activeTab
        ]


tabButton : Tab -> String -> Tab -> Html Msg
tabButton tab label activeTab =
    button
        [ HA.class
            (if tab == activeTab then
                "tab active"

             else
                "tab"
            )
        , onClick (TabClicked tab)
        ]
        [ text label ]


viewNetworkInfo : NetworkId -> Html Msg
viewNetworkInfo networkId =
    p [ HA.class "meta" ]
        [ text <|
            "Network: "
                ++ (case networkId of
                        Mainnet ->
                            "Mainnet"

                        Testnet ->
                            "Preview (Testnet)"
                   )
        ]


viewWalletBar : Model -> Html Msg
viewWalletBar model =
    div [ HA.class "wallet-bar" ]
        (case model.wallet of
            Just wallet ->
                [ span [ HA.class "connected" ]
                    [ text ("Connected: " ++ (Cip30.walletDescriptor wallet).name) ]
                , button [ onClick DisconnectWalletClicked ] [ text "Disconnect" ]
                ]

            Nothing ->
                if List.isEmpty model.walletsDiscovered then
                    [ span [ HA.class "meta" ] [ text "No wallets detected" ] ]

                else
                    List.map
                        (\w ->
                            button
                                [ onClick (ConnectWalletClicked { id = w.id, supportedExtensions = w.supportedExtensions }) ]
                                [ text ("Connect " ++ w.name) ]
                        )
                        model.walletsDiscovered
        )


viewStatus : Model -> Html Msg
viewStatus model =
    div []
        [ case model.protocolParams of
            Nothing ->
                p [ HA.class "loading" ] [ text "Loading protocol parameters..." ]

            Just _ ->
                text ""
        , case model.epoch of
            Loading ->
                p [ HA.class "loading" ] [ text "Loading epoch..." ]

            Success epoch ->
                p [ HA.class "meta" ] [ text ("Current epoch: " ++ String.fromInt epoch) ]

            Failure _ ->
                p [ HA.class "error" ] [ text "Failed to load epoch" ]

            NotAsked ->
                text ""
        ]



-- PROPOSALS TAB
-- SURVEYS TAB


viewSurveysTab : Model -> Html Msg
viewSurveysTab model =
    let
        isCancelled survey =
            List.any (\ref -> ref.txHash == survey.txHash && ref.index == survey.index)
                model.onchainCancellations
    in
    div []
        [ case model.onchainSurveys of
            NotAsked ->
                text ""

            Loading ->
                p [ HA.class "loading" ] [ text "Loading on-chain surveys..." ]

            Failure _ ->
                p [ HA.class "error" ] [ text "Failed to load surveys from chain" ]

            Success allSurveys ->
                let
                    currentEpoch =
                        RemoteData.withDefault 0 model.epoch

                    surveys =
                        List.filter (\s -> s.definition.endEpoch >= currentEpoch) allSurveys

                    ( cancelledSurveys, activeSurveys ) =
                        List.partition isCancelled surveys
                in
                if List.isEmpty activeSurveys && List.isEmpty cancelledSurveys then
                    div [ HA.class "empty-state" ]
                        [ p [] [ text "No active CIP-179 surveys found on-chain." ]
                        , p [ HA.class "meta" ]
                            [ text "Create one in the "
                            , button
                                [ HA.class "link-btn"
                                , onClick (TabClicked CreateSurveyTab)
                                ]
                                [ text "Create Survey" ]
                            , text " tab."
                            ]
                        ]

                else
                    div []
                        [ if not (List.isEmpty activeSurveys) then
                            div []
                                [ p [ HA.class "meta" ]
                                    [ text (String.fromInt (List.length activeSurveys) ++ " active survey(s) on-chain") ]
                                , div [ HA.class "proposals" ]
                                    (List.map viewOnchainSurvey activeSurveys)
                                ]

                          else
                            p [ HA.class "meta" ] [ text "No active surveys." ]
                        , if not (List.isEmpty cancelledSurveys) then
                            div [ HA.style "margin-top" "2rem" ]
                                [ h3 [] [ text "Cancelled Surveys" ]
                                , div [ HA.class "proposals" ]
                                    (List.map viewCancelledSurvey cancelledSurveys)
                                ]

                          else
                            text ""
                        ]
        ]


viewOnchainSurvey : OnchainSurvey -> Html Msg
viewOnchainSurvey survey =
    div []
        [ View.viewSurvey survey.definition
        , p [ HA.class "meta" ]
            [ text ("Tx: " ++ survey.txHash ++ " [" ++ String.fromInt survey.index ++ "]") ]
        , div [ HA.style "display" "flex", HA.style "gap" "0.5rem" ]
            [ button
                [ HA.class "btn btn-primary"
                , onClick (RespondToSurvey survey)
                ]
                [ text "Respond" ]
            , button
                [ HA.class "btn btn-danger"
                , onClick (CancelSurvey survey)
                ]
                [ text "Cancel" ]
            ]
        ]


viewCancelledSurvey : OnchainSurvey -> Html Msg
viewCancelledSurvey survey =
    div [ HA.class "survey-card", HA.style "opacity" "0.7" ]
        [ h3 []
            [ span [ HA.class "badge", HA.style "background" "#fee2e2", HA.style "color" "#b91c1c" ] [ text "Cancelled" ]
            , span [ HA.style "margin-left" "0.5rem" ] [ text survey.definition.title ]
            ]
        , p [ HA.class "meta" ]
            [ text ("Tx: " ++ survey.txHash ++ " [" ++ String.fromInt survey.index ++ "]") ]
        , p [ HA.class "meta" ]
            [ text ("Owner: " ++ ST.credentialToHex survey.definition.owner) ]
        ]



-- CREATE SURVEY TAB


viewCreateSurveyTab : Model -> Html Msg
viewCreateSurveyTab model =
    div []
        [ View.viewSurveyForm model.currentTime model.surveyForm model.surveyFormError (submitButtonLabel "Connect wallet to submit" "Submit Survey On-Chain" model) SurveyFormMsg
        , viewSubmissionStatus model.submissionStatus
        , case Form.formToDefinition model.currentTime model.surveyForm of
            Ok def ->
                div [ HA.class "metadatum-preview" ]
                    [ h3 [] [ text ("Preview: Metadatum (label " ++ String.fromInt ST.metadataLabel ++ ")") ]
                    , pre [] [ text (View.metadatumToString (Codec.toMetadatum def)) ]
                    ]

            Err _ ->
                text ""
        ]


submitButtonLabel : String -> String -> Model -> String
submitButtonLabel noWalletLabel walletLabel model =
    case model.submissionStatus of
        WaitingForSignature _ ->
            "Awaiting signature..."

        WaitingForSubmission _ ->
            "Submitting..."

        _ ->
            case model.wallet of
                Nothing ->
                    noWalletLabel

                Just _ ->
                    walletLabel


viewSubmissionStatus : SubmissionStatus -> Html Msg
viewSubmissionStatus status =
    case status of
        NotSubmitting ->
            text ""

        EncryptingBallot ->
            p [ HA.class "loading" ] [ text "Encrypting ballot with Drand tlock..." ]

        WaitingForSignature _ ->
            p [ HA.class "loading" ] [ text "Waiting for wallet signature..." ]

        WaitingForSubmission _ ->
            p [ HA.class "loading" ] [ text "Submitting transaction..." ]

        Submitted { txId } ->
            p [ HA.class "meta hash-match" ] [ text ("Transaction submitted! TxId: " ++ txId) ]

        SubmissionError err ->
            p [ HA.class "error" ] [ text ("Submission failed: " ++ err) ]



-- FILL SURVEY (RESPONSE) TAB


viewFillSurveyTab : Model -> Html Msg
viewFillSurveyTab model =
    case model.responseTarget of
        Nothing ->
            p [ HA.class "error" ] [ text "No survey selected" ]

        Just target ->
            div []
                [ button
                    [ HA.class "btn btn-secondary"
                    , onClick (TabClicked SurveysTab)
                    ]
                    [ text "Back to Surveys" ]
                , View.viewResponseForm
                    target.definition
                    model.responseForm
                    model.responseFormError
                    (submitButtonLabel "Connect wallet to respond" "Submit Response On-Chain" model)
                    ResponseFormMsg
                , viewSubmissionStatus model.submissionStatus
                ]


submitResponse : Model -> ( Model, Cmd Msg )
submitResponse model =
    case model.responseTarget of
        Nothing ->
            ( { model | responseFormError = Just "No survey selected" }, Cmd.none )

        Just target ->
            case ( model.wallet, model.walletUtxos ) of
                ( Nothing, _ ) ->
                    ( { model | responseFormError = Just "Please connect a wallet first" }, Cmd.none )

                ( _, Nothing ) ->
                    ( { model | responseFormError = Just "Wallet UTxOs not loaded yet" }, Cmd.none )

                ( Just wallet, _ ) ->
                    case Cardano.Address.extractPaymentCred (Cip30.walletChangeAddress wallet) of
                        Nothing ->
                            ( { model | responseFormError = Just "Could not extract credential from wallet address" }, Cmd.none )

                        Just cred ->
                            case target.definition.ballotMode of
                                ST.Public ->
                                    case Form.buildResponseMetadatum { txHash = target.txHash, index = target.index } cred model.responseForm of
                                        Err err ->
                                            ( { model | responseFormError = Just err }, Cmd.none )

                                        Ok responseMeta ->
                                            buildSignResponseTx model responseMeta

                                ST.Timelocked cfg ->
                                    case model.responseForm.role of
                                        Nothing ->
                                            ( { model | responseFormError = Just "Please select a role" }, Cmd.none )

                                        Just _ ->
                                            case Form.encodeResponseAnswers model.responseForm of
                                                Err err ->
                                                    ( { model | responseFormError = Just err }, Cmd.none )

                                                Ok encodedAnswers ->
                                                    let
                                                        plaintextHex =
                                                            Codec.plaintextHexForAnswers cfg.paddingSize encodedAnswers

                                                        ( newPool, cmd ) =
                                                            ConcurrentTask.attempt
                                                                { pool = model.taskPool
                                                                , send = sendTask
                                                                , onComplete = TimelockEncrypted
                                                                }
                                                                (Tlock.encrypt { round = cfg.round, plaintextHex = plaintextHex })
                                                    in
                                                    ( { model
                                                        | taskPool = newPool
                                                        , submissionStatus = EncryptingBallot
                                                        , responseFormError = Nothing
                                                      }
                                                    , cmd
                                                    )


{-| Finalize and request a signature for a response transaction carrying the
given (public or timelocked) response metadatum. Re-derives wallet context.
-}
buildSignResponseTx : Model -> Metadatum.Metadatum -> ( Model, Cmd Msg )
buildSignResponseTx model responseMeta =
    case ( model.wallet, model.walletUtxos ) of
        ( Just wallet, Just utxos ) ->
            let
                changeAddr =
                    Cip30.walletChangeAddress wallet
            in
            case Cardano.Address.extractPaymentCred changeAddr of
                Nothing ->
                    ( { model | responseFormError = Just "Could not extract credential from wallet address" }, Cmd.none )

                Just cred ->
                    let
                        requiredSignerInfo =
                            case cred of
                                VKeyHash hash ->
                                    [ TxRequiredSigner hash ]

                                ScriptHash _ ->
                                    []

                        txResult =
                            TxIntent.finalize utxos
                                (TxMetadata { tag = N.fromSafeInt ST.metadataLabel, metadata = responseMeta }
                                    :: requiredSignerInfo
                                )
                                [ Spend (FromWallet { address = changeAddr, value = Value.onlyLovelace N.zero, guaranteedUtxos = [] }) ]
                    in
                    case txResult of
                        Err err ->
                            ( { model | responseFormError = Just (TxIntent.errorToString err), submissionStatus = NotSubmitting }, Cmd.none )

                        Ok { tx } ->
                            ( { model
                                | submissionStatus = WaitingForSignature { tx = tx, createdSurvey = Nothing }
                                , responseFormError = Nothing
                              }
                            , toWallet (Cip30.encodeRequest (Cip30.signTx wallet { partialSign = False } tx))
                            )

        _ ->
            ( { model | responseFormError = Just "Wallet not ready", submissionStatus = NotSubmitting }, Cmd.none )



-- CANCEL SURVEY TAB


viewCancelSurveyTab : Model -> Html Msg
viewCancelSurveyTab model =
    case model.cancelTarget of
        Nothing ->
            p [ HA.class "error" ] [ text "No survey selected" ]

        Just target ->
            let
                ownerHex =
                    ST.credentialToHex target.definition.owner

                walletCredHex =
                    model.wallet
                        |> Maybe.andThen (\w -> Cardano.Address.extractPaymentCred (Cip30.walletChangeAddress w))
                        |> Maybe.map ST.credentialToHex

                ownerMatches =
                    walletCredHex == Just ownerHex
            in
            div []
                [ button
                    [ HA.class "btn btn-secondary"
                    , onClick (TabClicked SurveysTab)
                    ]
                    [ text "Back to Surveys" ]
                , div [ HA.class "survey-card", HA.style "margin-top" "1rem" ]
                    [ h3 [] [ text "Cancel Survey" ]
                    , View.viewSurvey target.definition
                    , p [ HA.class "meta" ]
                        [ text ("Tx: " ++ target.txHash ++ " [" ++ String.fromInt target.index ++ "]") ]
                    , if ownerMatches then
                        div []
                            [ p [ HA.class "meta hash-match" ] [ text "Owner credential matches your wallet." ]
                            , button
                                [ HA.class "btn btn-danger"
                                , HA.style "margin-top" "0.5rem"
                                , onClick ConfirmCancelSurvey
                                ]
                                [ text (submitButtonLabel "Connect wallet to cancel" "Confirm Cancellation" model) ]
                            ]

                      else
                        case walletCredHex of
                            Nothing ->
                                p [ HA.class "error" ] [ text "Please connect a wallet to verify ownership." ]

                            Just wHex ->
                                p [ HA.class "error" ]
                                    [ text ("Your wallet credential (" ++ wHex ++ ") does not match the survey owner (" ++ ownerHex ++ "). Only the owner can cancel.") ]
                    ]
                , viewSubmissionStatus model.submissionStatus
                ]


submitCancellation : Model -> ( Model, Cmd Msg )
submitCancellation model =
    case model.cancelTarget of
        Nothing ->
            ( { model | errors = "No survey selected for cancellation" :: model.errors }, Cmd.none )

        Just target ->
            case ( model.wallet, model.walletUtxos ) of
                ( Nothing, _ ) ->
                    ( { model | errors = "Please connect a wallet first" :: model.errors }, Cmd.none )

                ( _, Nothing ) ->
                    ( { model | errors = "Wallet UTxOs not loaded yet" :: model.errors }, Cmd.none )

                ( Just wallet, Just utxos ) ->
                    let
                        changeAddr =
                            Cip30.walletChangeAddress wallet

                        surveyRef =
                            { txHash = target.txHash, index = target.index }

                        cancellationMeta =
                            Codec.buildCancellationMetadatum surveyRef

                        requiredSignerInfo =
                            case target.definition.owner of
                                VKeyHash hash ->
                                    [ TxRequiredSigner hash ]

                                ScriptHash _ ->
                                    []

                        txResult =
                            TxIntent.finalize utxos
                                (TxMetadata { tag = N.fromSafeInt ST.metadataLabel, metadata = cancellationMeta }
                                    :: requiredSignerInfo
                                )
                                [ Spend (FromWallet { address = changeAddr, value = Value.onlyLovelace N.zero, guaranteedUtxos = [] }) ]
                    in
                    case txResult of
                        Err err ->
                            ( { model | errors = TxIntent.errorToString err :: model.errors }, Cmd.none )

                        Ok { tx } ->
                            ( { model
                                | submissionStatus = WaitingForSignature { tx = tx, createdSurvey = Nothing }
                              }
                            , toWallet (Cip30.encodeRequest (Cip30.signTx wallet { partialSign = False } tx))
                            )



-- RESPONSES TAB


viewResponsesTab : Model -> Html Msg
viewResponsesTab model =
    case model.onchainSurveys of
        NotAsked ->
            text ""

        Loading ->
            p [ HA.class "loading" ] [ text "Loading..." ]

        Failure _ ->
            p [ HA.class "error" ] [ text "Failed to load data" ]

        Success surveys ->
            let
                isCancelledRef ref =
                    List.any (\c -> c.txHash == ref.txHash && c.index == ref.index)
                        model.onchainCancellations

                nonCancelledResponses =
                    List.filter (\r -> not (isCancelledRef r.response.surveyRef))
                        model.onchainResponses
            in
            if List.isEmpty nonCancelledResponses then
                div [ HA.class "empty-state" ]
                    [ p [] [ text "No survey responses found on-chain." ] ]

            else
                let
                    groups =
                        groupResponsesBySurvey surveys nonCancelledResponses
                in
                div []
                    [ p [ HA.class "meta" ]
                        [ text
                            (String.fromInt (List.length nonCancelledResponses)
                                ++ " response(s) across "
                                ++ String.fromInt (List.length groups)
                                ++ " survey(s)"
                            )
                        ]
                    , div [ HA.class "proposals" ]
                        (List.map (viewResponseGroup model) groups)
                    ]


type alias ResponseGroup =
    { survey : Maybe OnchainSurvey
    , surveyRef : ST.SurveyRef
    , responses : List OnchainResponse
    }


groupResponsesBySurvey : List OnchainSurvey -> List OnchainResponse -> List ResponseGroup
groupResponsesBySurvey surveys responses =
    let
        refKey ref =
            ref.txHash ++ ":" ++ String.fromInt ref.index

        surveyDict =
            List.map (\s -> ( s.txHash ++ ":" ++ String.fromInt s.index, s )) surveys
                |> Dict.fromList
    in
    List.foldl
        (\resp acc ->
            let
                key =
                    refKey resp.response.surveyRef
            in
            Dict.update key
                (\existing ->
                    case existing of
                        Just group ->
                            Just { group | responses = group.responses ++ [ resp ] }

                        Nothing ->
                            Just
                                { survey = Dict.get key surveyDict
                                , surveyRef = resp.response.surveyRef
                                , responses = [ resp ]
                                }
                )
                acc
        )
        Dict.empty
        responses
        |> Dict.values


viewResponseGroup : Model -> ResponseGroup -> Html Msg
viewResponseGroup model group =
    let
        maybeDef =
            Maybe.map .definition group.survey
    in
    div [ HA.class "survey-card" ]
        [ case group.survey of
            Just survey ->
                div []
                    [ h3 [] [ text survey.definition.title ]
                    , p [ HA.class "meta" ]
                        [ text ("Tx: " ++ group.surveyRef.txHash ++ " [" ++ String.fromInt group.surveyRef.index ++ "]") ]
                    ]

            Nothing ->
                div []
                    [ h3 [] [ text "Unknown survey" ]
                    , p [ HA.class "meta" ]
                        [ text ("Ref: " ++ group.surveyRef.txHash ++ " [" ++ String.fromInt group.surveyRef.index ++ "]") ]
                    ]
        , p [ HA.class "meta" ]
            [ text (String.fromInt (List.length group.responses) ++ " response(s)") ]
        , div []
            (List.map (viewResponse model maybeDef) group.responses)
        ]


viewResponse : Model -> Maybe ST.SurveyDefinition -> OnchainResponse -> Html Msg
viewResponse model maybeDef resp =
    let
        r =
            resp.response
    in
    div [ HA.class "survey-card" ]
        [ p [ HA.class "meta" ] [ text ("Responder: " ++ ST.credentialToHex r.responder) ]
        , p [ HA.class "meta" ] [ text ("Role: " ++ ST.roleToString r.role) ]
        , case r.answers of
            ST.PublicAnswers items ->
                View.viewAnswerItems maybeDef items

            ST.TimelockedAnswers blob ->
                viewTimelockedAnswers model maybeDef resp blob
        ]


{-| Unique key for a timelocked ballot's decryption state: the submitting Tx
hash plus the ballot's position within that Tx's ballot list. (Responder
credential is not unique — one Tx may carry ballots for several surveys.)
-}
ballotKey : OnchainResponse -> String
ballotKey resp =
    resp.txHash ++ ":" ++ String.fromInt resp.ballotIndex


viewTimelockedAnswers : Model -> Maybe ST.SurveyDefinition -> OnchainResponse -> Bytes.Bytes Bytes.Any -> Html Msg
viewTimelockedAnswers model maybeDef resp blob =
    case Maybe.map .ballotMode maybeDef of
        Just (ST.Timelocked cfg) ->
            let
                revealTime =
                    Tlock.revealTimeOf cfg.round
            in
            if model.currentTime < revealTime then
                p [ HA.class "meta" ]
                    [ text
                        ("Locked timelocked ballot — revealable after Drand round "
                            ++ String.fromInt cfg.round
                            ++ " (~"
                            ++ String.fromInt (Basics.max 0 (revealTime - model.currentTime))
                            ++ "s remaining)"
                        )
                    ]

            else
                let
                    key =
                        ballotKey resp
                in
                case Dict.get key model.decryptedBallots of
                    Just Decrypting ->
                        p [ HA.class "loading" ] [ text "Decrypting ballot..." ]

                    Just (Decrypted items) ->
                        View.viewAnswerItems maybeDef items

                    Just (DecryptError err) ->
                        div []
                            [ p [ HA.class "error" ] [ text err ]
                            , button
                                [ HA.class "btn btn-sm"
                                , onClick (RevealBallot key (Bytes.toHex blob))
                                ]
                                [ text "Retry reveal" ]
                            ]

                    Nothing ->
                        button
                            [ HA.class "btn btn-primary"
                            , onClick (RevealBallot key (Bytes.toHex blob))
                            ]
                            [ text "Reveal answers" ]

        _ ->
            p [ HA.class "meta" ]
                [ text "Timelocked ballot (survey definition unknown — cannot determine reveal round)" ]



-- ERRORS


viewErrors : List String -> Html Msg
viewErrors errors =
    if List.isEmpty errors then
        text ""

    else
        div []
            (List.map (\err -> p [ HA.class "error" ] [ text err ]) errors)



-- MAIN


main : Program Flags Model Msg
main =
    Browser.element
        { init = init
        , update = update
        , subscriptions = subscriptions
        , view = view
        }
