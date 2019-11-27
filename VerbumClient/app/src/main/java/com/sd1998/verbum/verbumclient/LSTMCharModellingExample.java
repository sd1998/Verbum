package com.sd1998.verbum.verbumclient;

mport org.apache.commons.io.FileUtils;
import org.deeplearning4j.nn.conf.BackpropType;
import org.deeplearning4j.nn.conf.MultiLayerConfiguration;
import org.deeplearning4j.nn.conf.NeuralNetConfiguration;
import org.deeplearning4j.nn.conf.layers.LSTM;
import org.deeplearning4j.nn.conf.layers.RnnOutputLayer;
import org.deeplearning4j.nn.multilayer.MultiLayerNetwork;
import org.deeplearning4j.nn.weights.WeightInit;
import org.deeplearning4j.optimize.listeners.ScoreIterationListener;
import org.nd4j.linalg.activations.Activation;
import org.nd4j.linalg.api.ndarray.INDArray;
import org.nd4j.linalg.dataset.DataSet;
import org.nd4j.linalg.factory.Nd4j;
import org.nd4j.linalg.indexing.BooleanIndexing;
import org.nd4j.linalg.indexing.conditions.Conditions;
import org.nd4j.linalg.learning.config.Adam;
import org.nd4j.linalg.lossfunctions.LossFunctions.LossFunction;

import java.io.File;
import java.io.IOException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Random;

@SuppressWarnings("DuplicatedCode")
public class LSTMCharModellingExample {
    @SuppressWarnings("ConstantConditions")
    public static void main(String[] args ) throws Exception {
        int lstmLayerSize = 200;               //Number of units in each LSTM layer
        int miniBatchSize = 32;                   //Size of mini batch to use when  training
        int exampleLength = 1000;              //Length of each training example sequence to use. This could certainly be increased
        int tbpttLength = 50;                       //Length for truncated backpropagation through time. i.e., do parameter updates ever 50 characters
        int numEpochs = 1;                   //Total number of training epochs
        int generateSamplesEveryNMinibatches = 10;  //How frequently to generate samples from the network? 1000 characters / 50 tbptt length: 20 parameter updates per minibatch
        int nSamplesToGenerate = 4;                //Number of samples to generate after each training epoch
        int nCharactersToSample = 300;          //Length of each sample to generate
        String generationInitialization = null;       //Optional character initialization; a random character is used if null
        // Above is Used to 'prime' the LSTM with a character sequence to continue/complete.
        // Initialization characters must all be in CharacterIterator.getMinimalCharacterSet() by default
        Random rng = new Random(12345);

        //Get a DataSetIterator that handles vectorization of text into something we can use to train
        // our LSTM network.
        CharacterIterator iter = getShakespeareIterator(miniBatchSize,exampleLength);
        int nOut = iter.totalOutcomes();

        //Set up network configuration:
        MultiLayerConfiguration conf = new NeuralNetConfiguration.Builder()
                .seed(12345)
                .l2(0.0001)
                .weightInit(WeightInit.XAVIER)
                .updater(new Adam(0.005))
                .list()
                .layer(new LSTM.Builder().nIn(iter.inputColumns()).nOut(lstmLayerSize)
                        .activation(Activation.TANH).build())
                .layer(new LSTM.Builder().nIn(lstmLayerSize).nOut(lstmLayerSize)
                        .activation(Activation.TANH).build())
                .layer(new RnnOutputLayer.Builder(LossFunction.MCXENT).activation(Activation.SOFTMAX)        //MCXENT + softmax for classification
                        .nIn(lstmLayerSize).nOut(nOut).build())
                .backpropType(BackpropType.TruncatedBPTT).tBPTTForwardLength(tbpttLength).tBPTTBackwardLength(tbpttLength)
                .build();

        MultiLayerNetwork net = new MultiLayerNetwork(conf);
        net.init();
        net.setListeners(new ScoreIterationListener(1));

        //Print the  number of parameters in the network (and for each layer)
        System.out.println(net.summary());

        //Do training, and then generate and print samples from network
        int miniBatchNumber = 0;
        for( int i=0; i<numEpochs; i++ ){
            while(iter.hasNext()){
                DataSet ds = iter.next();
                net.fit(ds);
                if(++miniBatchNumber % generateSamplesEveryNMinibatches == 0){
                    System.out.println("--------------------");
                    System.out.println("Completed " + miniBatchNumber + " minibatches of size " + miniBatchSize + "x" + exampleLength + " characters" );
                    System.out.println("Sampling characters from network given initialization \"" + (generationInitialization == null ? "" : generationInitialization) + "\"");
                    String[] samples = sampleCharactersFromNetwork(generationInitialization,net,iter,rng,nCharactersToSample,nSamplesToGenerate);
                    for( int j=0; j<samples.length; j++ ){
                        System.out.println("----- Sample " + j + " -----");
                        System.out.println(samples[j]);
                        System.out.println();
                    }
                }
            }

            iter.reset();  //Reset iterator for another epoch
        }

        System.out.println("\n\nExample complete");
    }
    static CharacterIterator getShakespeareIterator(int miniBatchSize, int sequenceLength) throws Exception{
        //The Complete Works of William Shakespeare
        //5.3MB file in UTF-8 Encoding, ~5.4 million characters
        //https://www.gutenberg.org/ebooks/100
        String url = "https://s3.amazonaws.com/dl4j-distribution/pg100.txt";
        String tempDir = System.getProperty("java.io.tmpdir");
        String fileLocation = tempDir + "/Shakespeare.txt";    //Storage location from downloaded file
        File f = new File(fileLocation);
        if( !f.exists() ){
            FileUtils.copyURLToFile(new URL(url), f);
            System.out.println("File downloaded to " + f.getAbsolutePath());
        } else {
            System.out.println("Using existing text file at " + f.getAbsolutePath());
        }

        if(!f.exists()) throw new IOException("File does not exist: " + fileLocation); //Download problem?

        char[] validCharacters = CharacterIterator.getMinimalCharacterSet();   //Which characters are allowed? Others will be removed
        return new CharacterIterator(fileLocation, StandardCharsets.UTF_8,
                miniBatchSize, sequenceLength, validCharacters, new Random(12345));
    }

    private static String[] sampleCharactersFromNetwork(String initialization, MultiLayerNetwork net,
                                                        CharacterIterator iter, Random rng, int charactersToSample, int numSamples ){
        //Set up initialization. If no initialization: use a random character
        if( initialization == null ){
            initialization = String.valueOf(iter.getRandomCharacter());
        }

        //Create input for initialization
        INDArray initializationInput = Nd4j.zeros(numSamples, iter.inputColumns(), initialization.length());
        char[] init = initialization.toCharArray();
        for( int i=0; i<init.length; i++ ){
            int idx = iter.convertCharacterToIndex(init[i]);
            for( int j=0; j<numSamples; j++ ){
                initializationInput.putScalar(new int[]{j,idx,i}, 1.0f);
            }
        }

        StringBuilder[] sb = new StringBuilder[numSamples];
        for( int i=0; i<numSamples; i++ ) sb[i] = new StringBuilder(initialization);

        //Sample from network (and feed samples back into input) one character at a time (for all samples)
        //Sampling is done in parallel here
        net.rnnClearPreviousState();
        INDArray output = net.rnnTimeStep(initializationInput);
        output = output.tensorAlongDimension((int)output.size(2)-1,1,0);   //Gets the last time step output

        for (int i = 0; i < charactersToSample; i++) {
            //Set up next input (single time step) by sampling from previous output
            INDArray nextInput = Nd4j.zeros(numSamples, iter.inputColumns());
            INDArray cumsum = Nd4j.cumsum(output, 1);

            for (int s = 0; s < numSamples; s++) {
                //Output is a probability distribution. Sample from this for each example we want to generate, and add it to the new input
                int sampledCharacterIdx = BooleanIndexing.firstIndex(cumsum.getRow(s), Conditions.greaterThan(rng.nextDouble())).getInt(0);
                nextInput.putScalar(new int[]{s, sampledCharacterIdx}, 1.0f);        //Prepare next time step input
                sb[s].append(iter.convertIndexToCharacter(sampledCharacterIdx));    //Add sampled character to StringBuilder (human readable output)
            }

            output = net.rnnTimeStep(nextInput);    //Do one time step of forward pass
        }

        String[] out = new String[numSamples];
        for( int i=0; i<numSamples; i++ ) out[i] = sb[i].toString();
        return out;
    }

    static int sampleFromDistribution(double[] distribution, Random rng){
        double d = 0.0;
        double sum = 0.0;
        for( int t=0; t<10; t++ ) {
            d = rng.nextDouble();
            sum = 0.0;
            for( int i=0; i<distribution.length; i++ ){
                sum += distribution[i];
                if( d <= sum ) return i;
            }
            //If we haven't found the right index yet, maybe the sum is slightly
            //lower than 1 due to rounding error, so try again.
        }
        //Should be extremely unlikely to happen if distribution is a valid probability distribution
        throw new IllegalArgumentException("Distribution is invalid? d="+d+", sum="+sum);
    }
}