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
import Json.Decode as JD exposing (Decoder, Value)
import Natural as N
import RemoteData exposing (RemoteData(..), WebData)
import Route
import Sizing
import Survey.Codec as Codec
import Survey.Csv as Csv
import Survey.Form as Form
import Survey.Labels as Labels
import Survey.Results as Results
import Survey.Types as ST exposing (OnchainResponse, OnchainSurvey, ResponseState(..))
import Survey.View as View
import Task
import Time
import Tlock



-- PORTS


port toWallet : Value -> Cmd msg


port fromWallet : (Value -> msg) -> Sub msg


port sendTask : Value -> Cmd msg


port receiveTask : (Value -> msg) -> Sub msg


port copyToClipboard : String -> Cmd msg



-- MODEL


type Tab
    = SurveysTab
    | CreateSurveyTab
    | FillSurveyTab
    | ResponsesTab
    | CancelSurveyTab


type SubmissionStatus
    = NotSubmitting
    | EncryptingResponse
    | WaitingForSignature { tx : Transaction, createdSurvey : Maybe ST.SurveyDefinition }
    | WaitingForSubmission { tx : Transaction, createdSurvey : Maybe ST.SurveyDefinition }
    | Submitted { txId : String, createdSurvey : Maybe ST.SurveyDefinition }
    | SubmissionError String


type alias Flags =
    { url : String
    , db : Value
    }


type alias Model =
    { networkId : NetworkId
    , focus : Route.SurveyFocus
    , baseUrl : String
    , copiedKioskLink : Maybe String
    , db : Value
    , protocolParams : Maybe Api.ProtocolParams
    , chainTip : WebData Api.ChainTip
    , proposals : WebData (Dict String ActiveProposal)
    , walletsDiscovered : List WalletDescriptor
    , wallet : Maybe Cip30.Wallet
    , walletError : Maybe String
    , taskPool : ConcurrentTask.Pool Msg
    , errors : List String
    , activeTab : Tab
    , surveyForm : Form.SurveyForm
    , surveyFormError : Maybe String
    , createdSurveys : List ST.SurveyDefinition
    , onchainSurveys : WebData (List OnchainSurvey)
    , responsesBySurvey : Dict String (WebData (List OnchainResponse))
    , onchainCancellations : List ST.SurveyRef
    , surveyTxSlot : Dict String Int
    , walletUtxos : Maybe (Utxo.RefDict Output)
    , submissionStatus : SubmissionStatus
    , responseTarget : Maybe OnchainSurvey
    , responseForm : Form.ResponseForm
    , responseFormError : Maybe String
    , cancelTarget : Maybe OnchainSurvey
    , currentTime : Int
    , decryptedResponses : Dict String ResponseState
    , roundBeacons : Dict Int (RemoteData String String)
    , sizing : Sizing.State
    }


init : Flags -> ( Model, Cmd Msg )
init flags =
    let
        parsedUrl =
            Route.parseUrl flags.url

        networkId =
            parsedUrl.networkId

        model =
            { networkId = networkId
            , focus = parsedUrl.focus
            , baseUrl = baseUrlOf flags.url
            , copiedKioskLink = Nothing
            , db = flags.db
            , protocolParams = Nothing
            , chainTip = NotAsked
            , proposals = NotAsked
            , walletsDiscovered = []
            , wallet = Nothing
            , walletError = Nothing
            , taskPool = ConcurrentTask.pool
            , errors = []
            , activeTab = SurveysTab
            , surveyForm = Form.emptyForm
            , surveyFormError = Nothing
            , createdSurveys = []
            , onchainSurveys = NotAsked
            , responsesBySurvey = Dict.empty
            , onchainCancellations = []
            , surveyTxSlot = Dict.empty
            , walletUtxos = Nothing
            , submissionStatus = NotSubmitting
            , responseTarget = Nothing
            , responseForm = { role = Nothing, answers = [] }
            , responseFormError = Nothing
            , cancelTarget = Nothing
            , currentTime = 0
            , decryptedResponses = Dict.empty
            , roundBeacons = Dict.empty
            , sizing = Sizing.init
            }
    in
    ( { model | chainTip = Loading }
    , Cmd.batch
        [ Api.loadProtocolParams networkId GotProtocolParams
        , Api.queryTip networkId GotTip
        , toWallet (Cip30.encodeRequest Cip30.discoverWallets)
        , Task.perform Tick Time.now
        ]
    )


{-| Page URL stripped of any fragment and query string, used as the base for
shareable kiosk links.
-}
baseUrlOf : String -> String
baseUrlOf rawUrl =
    let
        before sep s =
            String.split sep s |> List.head |> Maybe.withDefault s
    in
    rawUrl |> before "#" |> before "?"


{-| Canonical `network` query-param value, matching `Route.parseNetwork`.
-}
networkParam : NetworkId -> String
networkParam networkId =
    case networkId of
        Mainnet ->
            "mainnet"

        Testnet ->
            "preview"


{-| Shareable single-survey ("kiosk") link for a survey, matching
`Route.parseFocus` and `Route.parseNetwork`. The network is pinned so the link
opens on the same network it was shared from.
-}
kioskUrl : String -> NetworkId -> { a | txHash : String, index : Int } -> String
kioskUrl base networkId ref =
    base ++ "?survey=" ++ ref.txHash ++ ":" ++ String.fromInt ref.index ++ "&network=" ++ networkParam networkId


{-| Cache/lookup key for a survey ref (also the responseLabel input shape).
-}
surveyRefKey : { a | txHash : String, index : Int } -> String
surveyRefKey r =
    r.txHash ++ ":" ++ String.fromInt r.index


{-| Kick off the per-survey response load: query that survey's `responseLabel`,
then fetch and decode only those response txs.
-}
loadResponsesFor : Model -> ST.SurveyRef -> ( Model, Cmd Msg )
loadResponsesFor model ref =
    ( { model | responsesBySurvey = Dict.insert (surveyRefKey ref) Loading model.responsesBySurvey }
    , Api.loadTxHashesByLabel model.networkId (Labels.responseLabel ref) (GotResponseTxHashes ref)
    )


{-| Already-loaded responses for a survey (empty until its per-survey load completes).
-}
cachedResponses : Model -> { a | txHash : String, index : Int } -> List OnchainResponse
cachedResponses model ref =
    Dict.get (surveyRefKey ref) model.responsesBySurvey
        |> Maybe.andThen RemoteData.toMaybe
        |> Maybe.withDefault []


{-| Start an independent decrypt task per response, all sharing one already-fetched
beacon (no network I/O). Each response updates its own `decryptedResponses` entry.
-}
startDecrypts : String -> List ( String, String ) -> Model -> ( Model, Cmd Msg )
startDecrypts beaconJson responses model =
    List.foldl
        (\( key, ciphertextHex ) ( m, cmds ) ->
            let
                ( newPool, cmd ) =
                    ConcurrentTask.attempt
                        { pool = m.taskPool
                        , send = sendTask
                        , onComplete = ResponseDecrypted key
                        }
                        (Tlock.decrypt { ciphertextHex = ciphertextHex, beaconJson = beaconJson })
            in
            ( { m | taskPool = newPool, decryptedResponses = Dict.insert key Decrypting m.decryptedResponses }
            , cmd :: cmds
            )
        )
        ( model, [] )
        responses
        |> Tuple.mapSecond Cmd.batch


{-| Mark every response of a failed round fetch with the error.
-}
failRound : Int -> List ( String, String ) -> String -> Model -> Model
failRound round responses err model =
    { model
        | roundBeacons = Dict.insert round (Failure err) model.roundBeacons
        , decryptedResponses =
            List.foldl (\( k, _ ) -> Dict.insert k (DecryptError ("Round fetch failed: " ++ err)))
                model.decryptedResponses
                responses
    }


{-| Timelocked responses of a survey that are not yet revealed, as
`(responseKey, ciphertextHex)` pairs ready for `RevealAll`.
-}
revealableResponses : Model -> List OnchainResponse -> List ( String, String )
revealableResponses model responses =
    List.filterMap
        (\resp ->
            case resp.response.answers of
                ST.TimelockedAnswers blob ->
                    let
                        key =
                            Results.responseKey resp
                    in
                    case Dict.get key model.decryptedResponses of
                        Just (Decrypted _) ->
                            Nothing

                        Just Decrypting ->
                            Nothing

                        _ ->
                            Just ( key, Bytes.toHex blob )

                ST.PublicAnswers _ ->
                    Nothing
        )
        responses



-- MSG


type Msg
    = WalletMsg Value
    | GotProtocolParams (Result Http.Error Api.ProtocolParams)
    | GotTip (Result Http.Error Api.ChainTip)
    | ConnectWalletClicked { id : String, supportedExtensions : List Int }
    | DisconnectWalletClicked
    | OnTaskProgress ( ConcurrentTask.Pool Msg, Cmd Msg )
    | TabClicked Tab
    | SurveyFormMsg Form.FormMsg
    | RespondToSurvey OnchainSurvey
    | ResponseFormMsg Form.ResponseFormMsg
    | CancelSurvey OnchainSurvey
    | ConfirmCancelSurvey
    | GotDirectoryTxHashes (Result Http.Error (List Api.SurveyTxSlot))
    | GotDirectoryMetadata (Result Http.Error (List Api.SurveyTxMetadata))
    | LoadResponses ST.SurveyRef
    | GotResponseTxHashes ST.SurveyRef (Result Http.Error (List Api.SurveyTxSlot))
    | GotResponseMetadata ST.SurveyRef (Result Http.Error (List Api.SurveyTxMetadata))
    | Tick Time.Posix
    | TimelockEncrypted (ConcurrentTask.Response String { ciphertextHex : String })
    | RevealResponse Int String String
    | RevealAll Int (List ( String, String ))
    | GotRoundBeacon Int (List ( String, String )) (ConcurrentTask.Response String { beaconJson : String })
    | ResponseDecrypted String (ConcurrentTask.Response String { plaintextHex : String })
    | ExportCsv OnchainSurvey
    | CopyKioskLink String
    | DismissErrors
    | ToggleNetwork
    | SizingMsg Sizing.Msg
    | SizingEncrypted (ConcurrentTask.Response String { ciphertextHex : String })



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

        GotTip result ->
            case result of
                Err _ ->
                    ( { model | chainTip = Failure Http.NetworkError }, Cmd.none )

                Ok tip ->
                    let
                        form =
                            model.surveyForm

                        prefilledForm =
                            if String.isEmpty form.endEpoch then
                                { form | endEpoch = String.fromInt (tip.epoch + 1) }

                            else
                                form
                    in
                    ( { model | chainTip = Success tip, surveyForm = prefilledForm, proposals = Loading, onchainSurveys = Loading }
                    , Api.loadTxHashesByLabel model.networkId Labels.definitionsLabel GotDirectoryTxHashes
                    )

        WalletMsg value ->
            case JD.decodeValue walletResponseDecoder value of
                Ok response ->
                    handleWalletResponse response model

                Err err ->
                    ( { model | errors = JD.errorToString err :: model.errors }, Cmd.none )

        ConnectWalletClicked { id, supportedExtensions } ->
            ( { model | walletError = Nothing }
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
            ( { model | wallet = Nothing, walletUtxos = Nothing, walletError = Nothing, submissionStatus = NotSubmitting }, Cmd.none )

        OnTaskProgress ( taskPool, cmd ) ->
            ( { model | taskPool = taskPool }, cmd )

        Tick posix ->
            ( { model | currentTime = Time.posixToMillis posix // 1000 }, Cmd.none )

        TimelockEncrypted response ->
            case response of
                ConcurrentTask.Success { ciphertextHex } ->
                    case ( model.responseTarget, model.responseForm.role, model.wallet ) of
                        ( Just target, Just role, Just wallet ) ->
                            case responderCredential (Just role) wallet of
                                Ok cred ->
                                    buildSignResponseTx model
                                        cred
                                        (Codec.buildTimelockedResponseMetadatum
                                            { txHash = target.txHash, index = target.index }
                                            role
                                            cred
                                            (Bytes.fromHexUnchecked ciphertextHex)
                                        )

                                Err err ->
                                    ( { model
                                        | submissionStatus = SubmissionError err
                                        , responseFormError = Just err
                                      }
                                    , Cmd.none
                                    )

                        _ ->
                            ( { model | submissionStatus = NotSubmitting }, Cmd.none )

                ConcurrentTask.Error err ->
                    ( { model
                        | submissionStatus = SubmissionError ("Response encryption failed: " ++ err)
                        , responseFormError = Just ("Response encryption failed: " ++ err)
                      }
                    , Cmd.none
                    )

                ConcurrentTask.UnexpectedError _ ->
                    ( { model
                        | submissionStatus = SubmissionError "Unexpected error during response encryption"
                        , responseFormError = Just "Unexpected error during response encryption"
                      }
                    , Cmd.none
                    )

        RevealResponse round key ciphertextHex ->
            update (RevealAll round [ ( key, ciphertextHex ) ]) model

        RevealAll round responses ->
            case Dict.get round model.roundBeacons of
                Just (Success beaconJson) ->
                    -- Beacon already fetched for this round: decrypt locally, no network.
                    startDecrypts beaconJson responses model

                _ ->
                    let
                        ( newPool, cmd ) =
                            ConcurrentTask.attempt
                                { pool = model.taskPool
                                , send = sendTask
                                , onComplete = GotRoundBeacon round responses
                                }
                                (Tlock.fetchRound { round = round })

                        decrypting =
                            List.foldl (\( k, _ ) -> Dict.insert k Decrypting) model.decryptedResponses responses
                    in
                    ( { model
                        | taskPool = newPool
                        , roundBeacons = Dict.insert round Loading model.roundBeacons
                        , decryptedResponses = decrypting
                      }
                    , cmd
                    )

        GotRoundBeacon round responses response ->
            case response of
                ConcurrentTask.Success { beaconJson } ->
                    startDecrypts beaconJson
                        responses
                        { model | roundBeacons = Dict.insert round (Success beaconJson) model.roundBeacons }

                ConcurrentTask.Error err ->
                    ( failRound round responses err model, Cmd.none )

                ConcurrentTask.UnexpectedError _ ->
                    ( failRound round responses "unexpected error" model, Cmd.none )

        ResponseDecrypted key response ->
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
            ( { model | decryptedResponses = Dict.insert key state model.decryptedResponses }, Cmd.none )

        ExportCsv survey ->
            let
                deduped =
                    Results.dedupLatestResponses model.surveyTxSlot (cachedResponses model survey)

                filename =
                    "survey-" ++ survey.txHash ++ "-" ++ String.fromInt survey.index ++ ".csv"
            in
            ( model, File.Download.string filename "text/csv" (Csv.buildCsv (revealedItems model) survey deduped) )

        CopyKioskLink url ->
            ( { model | copiedKioskLink = Just url }, copyToClipboard url )

        DismissErrors ->
            ( { model | errors = [] }, Cmd.none )

        ToggleNetwork ->
            let
                newNetwork =
                    toggleNetworkId model.networkId
            in
            -- Switching network invalidates everything fetched for the old one:
            -- the connected wallet (network-bound), all on-chain data, and any
            -- in-flight submission. Re-run the bootstrap loads; `queryTip`
            -- cascades into the survey-directory load.
            ( { model
                | networkId = newNetwork
                , wallet = Nothing
                , walletUtxos = Nothing
                , walletError = Nothing
                , submissionStatus = NotSubmitting
                , protocolParams = Nothing
                , chainTip = Loading
                , proposals = NotAsked
                , onchainSurveys = Loading
                , responsesBySurvey = Dict.empty
                , onchainCancellations = []
                , surveyTxSlot = Dict.empty
                , createdSurveys = []
                , responseTarget = Nothing
                , cancelTarget = Nothing
              }
            , Cmd.batch
                [ Api.loadProtocolParams newNetwork GotProtocolParams
                , Api.queryTip newNetwork GotTip
                ]
            )

        SizingMsg subMsg ->
            let
                ( newSizing, effect ) =
                    Sizing.update subMsg model.sizing
            in
            case effect of
                Sizing.NoEffect ->
                    ( { model | sizing = newSizing }, Cmd.none )

                Sizing.Encrypt plaintextHex ->
                    let
                        ( newPool, cmd ) =
                            ConcurrentTask.attempt
                                { pool = model.taskPool
                                , send = sendTask
                                , onComplete = SizingEncrypted
                                }
                                (Tlock.encrypt { round = Sizing.encryptRound, plaintextHex = plaintextHex })
                    in
                    ( { model | sizing = newSizing, taskPool = newPool }, cmd )

        SizingEncrypted response ->
            let
                result =
                    case response of
                        ConcurrentTask.Success { ciphertextHex } ->
                            Ok ciphertextHex

                        ConcurrentTask.Error err ->
                            Err err

                        ConcurrentTask.UnexpectedError _ ->
                            Err "Unexpected error during timelock encryption"
            in
            ( { model | sizing = Sizing.setCiphertext result model.sizing }, Cmd.none )

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

        GotDirectoryTxHashes result ->
            case result of
                Err err ->
                    ( { model | onchainSurveys = Failure err }, Cmd.none )

                Ok txSlots ->
                    let
                        txHashes =
                            List.map .txHash txSlots

                        newSlots =
                            List.foldl (\r -> Dict.insert r.txHash r.absoluteSlot) model.surveyTxSlot txSlots
                    in
                    if List.isEmpty txHashes then
                        ( { model | onchainSurveys = Success [], surveyTxSlot = newSlots }, Cmd.none )

                    else
                        ( { model | surveyTxSlot = newSlots }, Api.loadSurveyMetadata model.networkId txHashes GotDirectoryMetadata )

        GotDirectoryMetadata result ->
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
                                -- Newest first: order by the tx's absolute slot (desc).
                                -- sortBy is stable, so multiple defs in one tx keep their index order.
                                |> List.sortBy (\s -> negate (Maybe.withDefault 0 (Dict.get s.txHash model.surveyTxSlot)))

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

                        directoryModel =
                            { model
                                | onchainSurveys = Success surveys
                                , onchainCancellations = cancellations
                                , responseTarget = focusTarget
                                , responseForm = focusForm
                            }
                    in
                    -- In kiosk mode, immediately load the focused survey's responses.
                    case model.focus of
                        Route.Focus ref ->
                            loadResponsesFor directoryModel ref

                        _ ->
                            ( directoryModel, Cmd.none )

        LoadResponses ref ->
            loadResponsesFor model ref

        GotResponseTxHashes ref result ->
            case result of
                Err err ->
                    ( { model | responsesBySurvey = Dict.insert (surveyRefKey ref) (Failure err) model.responsesBySurvey }, Cmd.none )

                Ok txSlots ->
                    let
                        -- Keep each tx's absolute slot to resolve "latest response"
                        -- deterministically, independent of /tx_metadata's row order.
                        newSlots =
                            List.foldl (\r -> Dict.insert r.txHash r.absoluteSlot) model.surveyTxSlot txSlots

                        txHashes =
                            List.map .txHash txSlots
                    in
                    if List.isEmpty txHashes then
                        ( { model
                            | surveyTxSlot = newSlots
                            , responsesBySurvey = Dict.insert (surveyRefKey ref) (Success []) model.responsesBySurvey
                          }
                        , Cmd.none
                        )

                    else
                        ( { model | surveyTxSlot = newSlots }
                        , Api.loadSurveyMetadata model.networkId txHashes (GotResponseMetadata ref)
                        )

        GotResponseMetadata ref result ->
            case result of
                Err err ->
                    ( { model | responsesBySurvey = Dict.insert (surveyRefKey ref) (Failure err) model.responsesBySurvey }, Cmd.none )

                Ok txMetaList ->
                    let
                        -- The responseLabel query may include false positives from
                        -- label collisions, so validate each body's surveyRef.
                        responses =
                            List.concatMap
                                (\txMeta ->
                                    case Codec.fromMetadatum txMeta.metadatum of
                                        Ok (ST.ParsedResponses resps) ->
                                            List.indexedMap (\i r -> { txHash = txMeta.txHash, responseIndex = i, response = r }) resps

                                        _ ->
                                            []
                                )
                                txMetaList
                                |> List.filter (\r -> r.response.surveyRef.txHash == ref.txHash && r.response.surveyRef.index == ref.index)
                    in
                    ( { model | responsesBySurvey = Dict.insert (surveyRefKey ref) (Success responses) model.responsesBySurvey }, Cmd.none )


{-| Current epoch number, derived from the chain tip.
-}
currentEpoch : Model -> WebData Int
currentEpoch model =
    RemoteData.map .epoch model.chainTip


{-| Default reveal deadline (unix seconds) for the current form's end epoch,
used when the reveal-delay field is left blank: a couple of minutes after the
survey closes (the start of the epoch following `endEpoch`). `Nothing` until the
chain tip is loaded and the end epoch is a valid number.
-}
defaultRevealDeadline : Model -> Maybe Int
defaultRevealDeadline model =
    case ( RemoteData.toMaybe model.chainTip, String.toInt model.surveyForm.endEpoch ) of
        ( Just tip, Just endEpoch ) ->
            let
                epochLength =
                    Api.epochLengthSeconds model.networkId

                currentEpochStart =
                    tip.blockTime - tip.epochSlot

                surveyEnd =
                    currentEpochStart + (endEpoch + 1 - tip.epoch) * epochLength

                marginSeconds =
                    120
            in
            Just (surveyEnd + marginSeconds)

        _ ->
            Nothing


submitSurvey : Model -> ( Model, Cmd Msg )
submitSurvey model =
    case Form.formToDefinition model.currentTime (defaultRevealDeadline model) model.surveyForm of
        Err err ->
            ( { model | surveyFormError = Just err }, Cmd.none )

        Ok def ->
            case ( model.wallet, model.walletUtxos ) of
                ( Nothing, _ ) ->
                    ( { model | surveyFormError = Just "Please connect a wallet first" }, Cmd.none )

                ( _, Nothing ) ->
                    ( { model | surveyFormError = Just "Wallet UTxOs not loaded yet" }, Cmd.none )

                ( Just wallet, Just utxos ) ->
                    case checkWalletNetwork model.networkId wallet of
                        Err netErr ->
                            ( { model | surveyFormError = Just netErr }, Cmd.none )

                        Ok () ->
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
                                        (TxMetadata { tag = N.fromSafeInt Labels.metadataLabel, metadata = surveyMetadatum }
                                            :: TxMetadata { tag = N.fromSafeInt Labels.definitionsLabel, metadata = Metadatum.List [] }
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
            case checkWalletNetwork model.networkId wallet of
                Err err ->
                    ( { model | wallet = Nothing, walletError = Just err }, Cmd.none )

                Ok () ->
                    ( { model | wallet = Just wallet, walletError = Nothing }
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

            Route.SizingPage ->
                Html.map SizingMsg (Sizing.view model.networkId model.sizing)
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

        responsesState =
            Dict.get (surveyRefKey survey) model.responsesBySurvey
                |> Maybe.withDefault NotAsked

        deduped =
            Results.dedupLatestResponses model.surveyTxSlot (cachedResponses model survey)
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
        , case responsesState of
            Loading ->
                p [ HA.class "loading" ] [ text "Loading responses..." ]

            Failure _ ->
                p [ HA.class "error" ] [ text "Failed to load responses." ]

            _ ->
                text ""
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
                    case RemoteData.toMaybe (currentEpoch model) of
                        Just epoch ->
                            epoch <= survey.definition.endEpoch

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
how many of the (deduplicated) responses are revealed vs awaiting reveal. Renders
nothing for public surveys.
-}
viewRevealProgress : Model -> OnchainSurvey -> List OnchainResponse -> Html Msg
viewRevealProgress model survey deduped =
    case survey.definition.submissionMode of
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
                                case Dict.get (Results.responseKey r) model.decryptedResponses of
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
                    [ text ("Submission mode: timelocked (Drand round " ++ String.fromInt cfg.round ++ ")") ]
                , if isUnlocked then
                    p [ HA.class "meta" ] [ text "Reveal round reached — responses can be decrypted now." ]

                  else
                    p [ HA.class "meta" ]
                        [ text ("Locked — reveal in ~" ++ Tlock.formatDuration (revealTime - model.currentTime) ++ ".") ]
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
                , let
                    pendingResponses =
                        revealableResponses model deduped
                  in
                  if isUnlocked && not (List.isEmpty pendingResponses) then
                    button
                        [ HA.class "btn btn-primary btn-sm"
                        , HA.style "margin-top" "0.5rem"
                        , onClick (RevealAll cfg.round pendingResponses)
                        ]
                        [ text ("Reveal all " ++ String.fromInt (List.length pendingResponses) ++ " response(s)") ]

                  else
                    text ""
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
revealed (decrypted) timelocked response. `Nothing` means a timelocked response that
is not yet revealed (distinct from "answered nothing").
-}
revealedItems : Model -> OnchainResponse -> Maybe (List ST.AnswerItem)
revealedItems model resp =
    case resp.response.answers of
        ST.PublicAnswers answerItems ->
            Just answerItems

        ST.TimelockedAnswers _ ->
            case Dict.get (Results.responseKey resp) model.decryptedResponses of
                Just (Decrypted answerItems) ->
                    Just answerItems

                _ ->
                    Nothing


answerItemsOf : Model -> OnchainResponse -> List ST.AnswerItem
answerItemsOf model resp =
    revealedItems model resp |> Maybe.withDefault []


viewQuestionResult : List ST.AnswerItem -> Int -> ST.SurveyQuestion -> Html Msg
viewQuestionResult items qIdx question =
    case question of
        ST.SingleChoice { prompt, options } ->
            viewChoiceTally prompt options (Results.singleChoiceCounts qIdx options items)

        ST.MultiSelect { prompt, options } ->
            viewChoiceTally prompt options (Results.multiSelectCounts qIdx options items)

        ST.Ranking { prompt } ->
            viewNoAggregation prompt "Ranking"

        ST.NumericRange { prompt } ->
            viewNoAggregation prompt "Numeric"

        ST.Custom { prompt } ->
            viewNoAggregation prompt "Custom"


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
    case RemoteData.toMaybe (currentEpoch model) of
        Nothing ->
            p [ HA.class "meta" ] [ text "Status: unknown (epoch not loaded)" ]

        Just epoch ->
            let
                endEpoch =
                    survey.definition.endEpoch
            in
            if epoch <= endEpoch then
                p [ HA.class "meta" ]
                    [ text
                        ("Status: Open — ends at epoch "
                            ++ String.fromInt endEpoch
                            ++ " ("
                            ++ String.fromInt (endEpoch - epoch)
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
        [ text ("Network: " ++ networkIdName networkId ++ " ")
        , button [ onClick ToggleNetwork ]
            [ text ("Switch to " ++ networkIdName (toggleNetworkId networkId)) ]
        ]


viewWalletBar : Model -> Html Msg
viewWalletBar model =
    let
        walletErrorView =
            case model.walletError of
                Just err ->
                    [ p [ HA.class "error" ] [ text err ] ]

                Nothing ->
                    []
    in
    div [ HA.class "wallet-bar" ]
        ((case model.wallet of
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
            ++ walletErrorView
        )


viewStatus : Model -> Html Msg
viewStatus model =
    div []
        [ case model.protocolParams of
            Nothing ->
                p [ HA.class "loading" ] [ text "Loading protocol parameters..." ]

            Just _ ->
                text ""
        , case currentEpoch model of
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
                    epoch =
                        RemoteData.withDefault 0 (currentEpoch model)

                    surveys =
                        List.filter (\s -> s.definition.endEpoch >= epoch) allSurveys

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
                                    (List.map (viewOnchainSurvey model) activeSurveys)
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


viewOnchainSurvey : Model -> OnchainSurvey -> Html Msg
viewOnchainSurvey model survey =
    let
        shareLink =
            kioskUrl model.baseUrl model.networkId survey
    in
    div []
        [ View.viewSurvey survey.definition
        , p [ HA.class "meta" ]
            [ text ("Tx: " ++ survey.txHash ++ " [" ++ String.fromInt survey.index ++ "]") ]
        , div [ HA.style "display" "flex", HA.style "gap" "0.5rem", HA.style "align-items" "center" ]
            [ button
                [ HA.class "btn btn-primary"
                , onClick (RespondToSurvey survey)
                ]
                [ text "Respond" ]
            , button
                [ HA.class "btn btn-secondary"
                , onClick (CopyKioskLink shareLink)
                ]
                [ text "Share link" ]
            , if model.copiedKioskLink == Just shareLink then
                span [ HA.class "meta", HA.style "color" "#16a34a" ] [ text "Copied!" ]

              else
                text ""
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
        [ View.viewSurveyForm model.currentTime (defaultRevealDeadline model) model.surveyForm model.surveyFormError (submitButtonLabel "Connect wallet to submit" "Submit Survey On-Chain" model) SurveyFormMsg
        , viewSubmissionStatus model.submissionStatus
        , case Form.formToDefinition model.currentTime (defaultRevealDeadline model) model.surveyForm of
            Ok def ->
                div [ HA.class "metadatum-preview" ]
                    [ h3 [] [ text ("Preview: Metadatum (label " ++ String.fromInt Labels.metadataLabel ++ ")") ]
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

        EncryptingResponse ->
            p [ HA.class "loading" ] [ text "Encrypting response with Drand tlock..." ]

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


{-| Human-readable network name, shared by the network banner and the
wallet-network guard.
-}
networkIdName : NetworkId -> String
networkIdName networkId =
    case networkId of
        Mainnet ->
            "Mainnet"

        Testnet ->
            "Preview (Testnet)"


{-| The other network, for the network-switch toggle.
-}
toggleNetworkId : NetworkId -> NetworkId
toggleNetworkId networkId =
    case networkId of
        Mainnet ->
            Testnet

        Testnet ->
            Mainnet


{-| Guard: the connected wallet must operate on the same network the app targets.
We read the network byte of the wallet's change address instead of issuing a
CIP-30 `getNetworkId` request. A mismatch would silently desync on-chain reads
(the Koios endpoint is picked by the app's network) from tx submission (routed by
the wallet), so callers reject the wallet / block tx building on `Err`.
-}
checkWalletNetwork : NetworkId -> Cip30.Wallet -> Result String ()
checkWalletNetwork expected wallet =
    case Cardano.Address.extractNetworkId (Cip30.walletChangeAddress wallet) of
        Just actual ->
            if actual == expected then
                Ok ()

            else
                Err ("Wallet is on " ++ networkIdName actual ++ " but this app targets " ++ networkIdName expected ++ ". Switch your wallet's network and reconnect.")

        Nothing ->
            Err "Could not determine the wallet's network from its change address."


{-| Credential identifying a responder for the given role. Stakeholder votes are
keyed by the wallet's stake key (so the same payment key voting from different
stake accounts stays distinct); all other roles use the payment credential.
-}
responderCredential : Maybe ST.Role -> Cip30.Wallet -> Result String Credential
responderCredential maybeRole wallet =
    let
        changeAddr =
            Cip30.walletChangeAddress wallet
    in
    case maybeRole of
        Just ST.Stakeholder ->
            case Cardano.Address.extractStakeCredential changeAddr of
                Just (Cardano.Address.InlineCredential cred) ->
                    Ok cred

                _ ->
                    Err "Could not extract a stake key from the wallet address (stakeholder votes require an inline stake credential)"

        _ ->
            case Cardano.Address.extractPaymentCred changeAddr of
                Just cred ->
                    Ok cred

                Nothing ->
                    Err "Could not extract credential from wallet address"


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
                    case responderCredential model.responseForm.role wallet of
                        Err err ->
                            ( { model | responseFormError = Just err }, Cmd.none )

                        Ok cred ->
                            case target.definition.submissionMode of
                                ST.Public ->
                                    case Form.buildResponseMetadatum { txHash = target.txHash, index = target.index } cred model.responseForm of
                                        Err err ->
                                            ( { model | responseFormError = Just err }, Cmd.none )

                                        Ok responseMeta ->
                                            buildSignResponseTx model cred responseMeta

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
                                                        , submissionStatus = EncryptingResponse
                                                        , responseFormError = Nothing
                                                      }
                                                    , cmd
                                                    )


{-| Finalize and request a signature for a response transaction carrying the
given (public or timelocked) response metadatum. Re-derives wallet context.
-}
buildSignResponseTx : Model -> Credential -> Metadatum.Metadatum -> ( Model, Cmd Msg )
buildSignResponseTx model responderCred responseMeta =
    case ( model.wallet, model.walletUtxos ) of
        ( Just wallet, Just utxos ) ->
            case checkWalletNetwork model.networkId wallet of
                Err netErr ->
                    ( { model | responseFormError = Just netErr, submissionStatus = NotSubmitting }, Cmd.none )

                Ok () ->
                    let
                        changeAddr =
                            Cip30.walletChangeAddress wallet

                        requiredSignerInfo =
                            case responderCred of
                                VKeyHash hash ->
                                    [ TxRequiredSigner hash ]

                                ScriptHash _ ->
                                    []

                        responseLabelInfo =
                            case model.responseTarget of
                                Just survey ->
                                    [ TxMetadata
                                        { tag = N.fromSafeInt (Labels.responseLabel { txHash = survey.txHash, index = survey.index })
                                        , metadata = Metadatum.List []
                                        }
                                    ]

                                Nothing ->
                                    []

                        txResult =
                            TxIntent.finalize utxos
                                (TxMetadata { tag = N.fromSafeInt Labels.metadataLabel, metadata = responseMeta }
                                    :: (responseLabelInfo ++ requiredSignerInfo)
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
                            , toWallet (Cip30.encodeRequest (Cip30.signTx wallet { partialSign = True } tx))
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
                    case checkWalletNetwork model.networkId wallet of
                        Err netErr ->
                            ( { model | errors = netErr :: model.errors }, Cmd.none )

                        Ok () ->
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
                                        (TxMetadata { tag = N.fromSafeInt Labels.metadataLabel, metadata = cancellationMeta }
                                            :: TxMetadata { tag = N.fromSafeInt Labels.definitionsLabel, metadata = Metadatum.List [] }
                                            :: TxMetadata { tag = N.fromSafeInt (Labels.responseLabel surveyRef), metadata = Metadatum.List [] }
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
                isCancelled survey =
                    List.any (\c -> c.txHash == survey.txHash && c.index == survey.index)
                        model.onchainCancellations

                activeSurveys =
                    List.filter (not << isCancelled) surveys
            in
            if List.isEmpty activeSurveys then
                div [ HA.class "empty-state" ]
                    [ p [] [ text "No surveys on-chain." ] ]

            else
                div []
                    [ p [ HA.class "meta" ]
                        [ text "Select a survey to load its on-chain responses." ]
                    , div [ HA.class "proposals" ]
                        (List.map (viewResponsesForSurvey model) activeSurveys)
                    ]


{-| One survey card in the Responses tab. Responses load on demand (per-survey
`responseLabel` query) when the user clicks, rather than all upfront.
-}
viewResponsesForSurvey : Model -> OnchainSurvey -> Html Msg
viewResponsesForSurvey model survey =
    let
        ref =
            { txHash = survey.txHash, index = survey.index }

        state =
            Dict.get (surveyRefKey survey) model.responsesBySurvey
                |> Maybe.withDefault NotAsked
    in
    div [ HA.class "survey-card" ]
        [ h3 [] [ text survey.definition.title ]
        , p [ HA.class "meta" ]
            [ text ("Tx: " ++ survey.txHash ++ " [" ++ String.fromInt survey.index ++ "]") ]
        , case state of
            NotAsked ->
                button [ HA.class "btn btn-primary", onClick (LoadResponses ref) ]
                    [ text "Load responses" ]

            Loading ->
                p [ HA.class "loading" ] [ text "Loading responses..." ]

            Failure _ ->
                div []
                    [ p [ HA.class "error" ] [ text "Failed to load responses." ]
                    , button [ HA.class "btn", onClick (LoadResponses ref) ] [ text "Retry" ]
                    ]

            Success responses ->
                if List.isEmpty responses then
                    p [ HA.class "meta" ] [ text "No responses yet." ]

                else
                    div []
                        [ p [ HA.class "meta" ]
                            [ text (String.fromInt (List.length responses) ++ " response(s)") ]
                        , div []
                            (List.map (viewResponse model (Just survey.definition)) responses)
                        , button [ HA.class "btn", onClick (LoadResponses ref) ] [ text "Refresh" ]
                        ]
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


viewTimelockedAnswers : Model -> Maybe ST.SurveyDefinition -> OnchainResponse -> Bytes.Bytes Bytes.Any -> Html Msg
viewTimelockedAnswers model maybeDef resp blob =
    case Maybe.map .submissionMode maybeDef of
        Just (ST.Timelocked cfg) ->
            let
                revealTime =
                    Tlock.revealTimeOf cfg.round
            in
            if model.currentTime < revealTime then
                p [ HA.class "meta" ]
                    [ text
                        ("Locked timelocked response — revealable after Drand round "
                            ++ String.fromInt cfg.round
                            ++ " (~"
                            ++ Tlock.formatDuration (revealTime - model.currentTime)
                            ++ " remaining)"
                        )
                    ]

            else
                let
                    key =
                        Results.responseKey resp
                in
                case Dict.get key model.decryptedResponses of
                    Just Decrypting ->
                        p [ HA.class "loading" ] [ text "Decrypting response..." ]

                    Just (Decrypted items) ->
                        View.viewAnswerItems maybeDef items

                    Just (DecryptError err) ->
                        div []
                            [ p [ HA.class "error" ] [ text err ]
                            , button
                                [ HA.class "btn btn-sm"
                                , onClick (RevealResponse cfg.round key (Bytes.toHex blob))
                                ]
                                [ text "Retry reveal" ]
                            ]

                    Nothing ->
                        button
                            [ HA.class "btn btn-primary"
                            , onClick (RevealResponse cfg.round key (Bytes.toHex blob))
                            ]
                            [ text "Reveal answers" ]

        _ ->
            p [ HA.class "meta" ]
                [ text "Timelocked response (survey definition unknown — cannot determine reveal round)" ]



-- ERRORS


viewErrors : List String -> Html Msg
viewErrors errors =
    if List.isEmpty errors then
        text ""

    else
        div []
            (List.map (\err -> p [ HA.class "error" ] [ text err ]) errors
                ++ [ button [ onClick DismissErrors ] [ text "Dismiss errors" ] ]
            )



-- MAIN


main : Program Flags Model Msg
main =
    Browser.element
        { init = init
        , update = update
        , subscriptions = subscriptions
        , view = view
        }
