"""Entry point for the stocks application."""

from portfolio import Portfolio
from stocks import calculate_stats


def main():
    # Demo portfolio
    portfolio = Portfolio()
    portfolio.add_position("AAPL", 10, 150.00)
    portfolio.add_position("MSFT", 5, 280.00)
    portfolio.add_position("GOOGL", 2, 2800.00)

    # Simulated current prices
    current_prices = {
        "AAPL": 175.50,
        "MSFT": 310.00,
        "GOOGL": 3000.00,
    }

    print("=== Portfolio Summary ===")
    print(f"{'Symbol':<8} {'Shares':>6} {'Avg Cost':>10} {'Price':>10} {'Value':>12} {'Gain/Loss':>12}")
    print("-" * 62)

    for row in portfolio.summary(current_prices):
        print(
            f"{row['symbol']:<8} {row['shares']:>6} "
            f"${row['avg_cost']:>9.2f} ${row['current_price']:>9.2f} "
            f"${row['value']:>11.2f} ${row['gain_loss']:>+11.2f}"
        )

    print("-" * 62)
    total_value = portfolio.get_value(current_prices)
    total_cost = portfolio.get_cost_basis()
    total_gain = total_value - total_cost
    print(f"{'Total':<8} {'':>6} {'':>10} {'':>10} ${total_value:>11.2f} ${total_gain:>+11.2f}")

    print()
    # Example stats calculation
    sample_prices = [150.0, 155.0, 148.0, 162.0, 175.5]
    stats = calculate_stats(sample_prices)
    print("=== AAPL Price Stats (sample) ===")
    for key, value in stats.items():
        print(f"  {key}: {value:.2f}")


if __name__ == "__main__":
    main()
