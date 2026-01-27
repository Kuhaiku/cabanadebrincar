# Usa uma imagem leve do Node.js (Alpine Linux)
FROM node:18-alpine

# Define o diretório de trabalho dentro do container
WORKDIR /app

# Copia os arquivos de dependência primeiro (para aproveitar o cache do Docker)
COPY package*.json ./

# Instala as dependências do projeto
RUN npm install --production

# Copia todo o restante do código fonte para dentro do container
COPY . .

# Expõe a porta que o servidor usa (3000 definida no seu server.js)
EXPOSE 3000

# Comando para iniciar a aplicação
CMD ["node", "server.js"]