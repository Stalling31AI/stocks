"""Stock data fetching and analysis utilities."""

import requests


def get_stock_quote(symbol: str, api_key: str) -> dict:
    """Fetch the latest quote for a stock symbol from Alpha Vantage."""
    url = "https://www.alphavantage.co/query"
    params = {
        "function": "GLOBAL_QUOTE",
        "symbol": symbol.upper(),
        "apikey": api_key,
    }
    response = requests.get(url, params=params, timeout=10)
    response.raise_for_status()
    data = response.json()
    quote = data.get("Global Quote", {})
    if not quote:
        raise ValueError(f"No data found for symbol: {symbol}")
    return {
        "symbol": quote.get("01. symbol"),
        "price": float(quote.get("05. price", 0)),
        "change": float(quote.get("09. change", 0)),
        "change_percent": quote.get("10. change percent", "0%"),
        "volume": int(quote.get("06. volume", 0)),
        "latest_trading_day": quote.get("07. latest trading day"),
    }


def calculate_stats(prices: list) -> dict:
    """Calculate basic statistics for a list of prices."""
    if not prices:
        return {}
    return {
        "min": min(prices),
        "max": max(prices),
        "average": sum(prices) / len(prices),
        "change": prices[-1] - prices[0] if len(prices) > 1 else 0,
        "change_percent": (
            ((prices[-1] - prices[0]) / prices[0] * 100) if prices[0] != 0 else 0
        ),
    }
