"""Portfolio management for tracking stock holdings."""


class Portfolio:
    """Manages a collection of stock positions."""

    def __init__(self):
        self.positions = {}  # symbol -> {"shares": int, "avg_cost": float}

    def add_position(self, symbol: str, shares: int, price: float):
        """Add or update a position."""
        symbol = symbol.upper()
        if symbol in self.positions:
            existing = self.positions[symbol]
            total_shares = existing["shares"] + shares
            total_cost = existing["shares"] * existing["avg_cost"] + shares * price
            self.positions[symbol] = {
                "shares": total_shares,
                "avg_cost": total_cost / total_shares,
            }
        else:
            self.positions[symbol] = {"shares": shares, "avg_cost": price}

    def remove_position(self, symbol: str):
        """Remove a position from the portfolio."""
        self.positions.pop(symbol.upper(), None)

    def get_value(self, current_prices: dict) -> float:
        """Calculate total portfolio value given current prices."""
        total = 0.0
        for symbol, pos in self.positions.items():
            price = current_prices.get(symbol, pos["avg_cost"])
            total += pos["shares"] * price
        return total

    def get_cost_basis(self) -> float:
        """Calculate total cost basis of the portfolio."""
        return sum(pos["shares"] * pos["avg_cost"] for pos in self.positions.values())

    def summary(self, current_prices: dict = None) -> list:
        """Return a summary of all positions."""
        current_prices = current_prices or {}
        rows = []
        for symbol, pos in self.positions.items():
            current_price = current_prices.get(symbol, pos["avg_cost"])
            value = pos["shares"] * current_price
            cost = pos["shares"] * pos["avg_cost"]
            rows.append({
                "symbol": symbol,
                "shares": pos["shares"],
                "avg_cost": pos["avg_cost"],
                "current_price": current_price,
                "value": value,
                "gain_loss": value - cost,
            })
        return rows
