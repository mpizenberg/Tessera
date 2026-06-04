module Route exposing (ParsedUrl, SurveyFocus(..), parseUrl)

{-| URL routing: parse the page URL into the target network and an optional
single-survey ("kiosk") focus.
-}

import AppUrl
import Cardano.Address exposing (NetworkId(..))
import Dict
import Survey.Types as ST
import Url


{-| Everything read from the initial page URL: the target network and the
optional single-survey ("kiosk") focus.
-}
type alias ParsedUrl =
    { networkId : NetworkId
    , focus : SurveyFocus
    }


{-| URL-driven single-survey ("kiosk") focus, parsed once from `flags.url`.
-}
type SurveyFocus
    = NoFocus
    | InvalidFocus String
    | Focus ST.SurveyRef
    | SizingPage


{-| Parse the initial page URL once into network selection plus survey focus.

  - `network`: `mainnet` selects Mainnet; `preview`, any other value, or absence
    defaults to Preview (Testnet). Case-insensitive.
  - `survey=<txHash>[:<index>]` switches into single-survey kiosk mode. No
    parameter keeps the normal tabbed app; a present-but-malformed value yields
    an error focus.

-}
parseUrl : String -> ParsedUrl
parseUrl rawUrl =
    case Url.fromString rawUrl of
        Nothing ->
            { networkId = Testnet, focus = NoFocus }

        Just url ->
            let
                param name =
                    Dict.get name (AppUrl.fromUrl url).queryParameters
                        |> Maybe.andThen List.head
            in
            { networkId =
                case param "network" of
                    Just value ->
                        if String.toLower value == "mainnet" then
                            Mainnet

                        else
                            Testnet

                    Nothing ->
                        Testnet
            , focus =
                case param "page" of
                    Just "sizing" ->
                        SizingPage

                    _ ->
                        case param "survey" of
                            Nothing ->
                                NoFocus

                            Just raw ->
                                parseSurveyRef raw
            }


parseSurveyRef : String -> SurveyFocus
parseSurveyRef raw =
    case String.split ":" raw of
        [ hash ] ->
            focusFromParts hash 0

        [ hash, idxStr ] ->
            case String.toInt idxStr of
                Just idx ->
                    focusFromParts hash idx

                Nothing ->
                    InvalidFocus ("Invalid survey index: \"" ++ idxStr ++ "\" is not a number.")

        _ ->
            InvalidFocus "Malformed survey link. Expected ?survey=<txHash>:<index>."


focusFromParts : String -> Int -> SurveyFocus
focusFromParts hash index =
    if index < 0 then
        InvalidFocus "Invalid survey index: must be zero or positive."

    else if String.length hash == 64 && String.all Char.isHexDigit hash then
        Focus { txHash = String.toLower hash, index = index }

    else
        InvalidFocus "Invalid survey transaction hash: expected 64 hex characters."
