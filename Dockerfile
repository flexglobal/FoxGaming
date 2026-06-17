# Используем легкий образ Node.js
FROM node:18-slim

# Создаем рабочую директорию
WORKDIR /app

# Копируем зависимости
COPY package*.json ./
RUN npm install

# Копируем остальной код
COPY . .

# Открываем порт, который слушает твой сервер
EXPOSE 8080

# Команда запуска
CMD [ "node", "server.js" ]