# control flow tasks

mark = int(input("mark: "))
if mark >= 50:
    print("Pass")
else:
    print("Fail")

# countdown
i = 10
while i > 0:
    print(i)
    i = i - 1
print("Lift off!")

# sum of even numbers
total = 0
for n in range(1, 101):
    if n % 2 == 0:
        total = total + n
print(total)

# fizzbuzz
for n in range(1, 31):
    if n % 3 == 0:
        print("Fizz")
    if n % 5 == 0:
        print("Buzz")
    else:
        print(n)

# guess my number - not finished
secret = 42
guess = int(input("guess: "))
if guess == secret:
    print("correct")
