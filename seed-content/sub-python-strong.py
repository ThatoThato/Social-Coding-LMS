# A2 - Control Flow Challenge
# Name: submitted through the LMS

def pass_fail(mark):
    """Return the band for a mark out of 100."""
    if mark >= 80:
        return "Distinction"
    elif mark >= 50:
        return "Pass"
    return "Fail"


def countdown(start):
    for n in range(start, 0, -1):
        print(n)
    print("Lift off!")


def sum_of_evens(limit):
    total = 0
    for n in range(2, limit + 1, 2):
        total += n
    return total


def fizz_buzz(limit):
    for n in range(1, limit + 1):
        if n % 15 == 0:
            print("FizzBuzz")
        elif n % 3 == 0:
            print("Fizz")
        elif n % 5 == 0:
            print("Buzz")
        else:
            print(n)


def guess_my_number(secret):
    attempts = 0
    while True:
        guess = int(input("Your guess: "))
        attempts += 1
        if guess > secret:
            print("Too high")
        elif guess < secret:
            print("Too low")
        else:
            print(f"Correct in {attempts} attempts")
            return attempts


if __name__ == "__main__":
    mark = int(input("Enter a mark: "))
    print(pass_fail(mark))
    countdown(10)
    print("Sum of evens to 100:", sum_of_evens(100))
    fizz_buzz(30)
    guess_my_number(42)
